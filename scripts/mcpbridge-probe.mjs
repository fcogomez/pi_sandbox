#!/usr/bin/env node
/**
 * mcpbridge-probe.mjs — M1/M2 phase-1 research probe (2026-11-13)
 *
 * Drives an MCP stdio server (default: `xcrun mcpbridge`) with a minimal
 * MCP client sequence and prints every frame, for wire research:
 *
 *   1. spawn the server (default: xcrun mcpbridge)
 *   2. initialize  -> print server response (protocolVersion, capabilities, serverInfo)
 *   3. notifications/initialized
 *   4. tools/list  -> print the full tool list (names, input schemas)
 *   5. optional: tools/call <name> '<json-args>' (read-only tools only, e.g.
 *      DocumentationSearch — do NOT call BuildProject from this probe)
 *
 * Usage (on the Mac, project open in Xcode, Intelligence setting enabled):
 *   node mcpbridge-probe.mjs                      # handshake + tool list
 *   node mcpbridge-probe.mjs --call DocumentationSearch '{"query":"SwiftUI List"}'
 *   node mcpbridge-probe.mjs --cmd "xcrun mcpbridge" --extra-env MCP_XCODE_PID=1234
 *
 * Exit codes: 0 = got tools/list result (or the requested call result);
 *             2 = server exited early (its stderr is printed);
 *             3 = timeout.
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
let cmd = "xcrun";
let argv = ["mcpbridge"];
let callName = null;
let callArgsJson = null;
let extraEnv = {};

// --cmd accepts a full command line: "xcrun mcpbridge",
// "node /path/to/server.mjs", or a bare binary (argv stays ["mcpbridge"]).
function setCmd(value) {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 1) { cmd = parts[0]; argv = ["mcpbridge"]; }
  else { cmd = parts[0]; argv = parts.slice(1); }
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cmd") { setCmd(args[++i]); }
  else if (args[i] === "--call") { callName = args[++i]; callArgsJson = args[++i] ?? "{}"; }
  else if (args[i] === "--extra-env") {
    const kv = args[++i];
    const eq = kv.indexOf("=");
    if (eq > 0) extraEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (args[i].startsWith("--cmd=")) {
    setCmd(args[i].slice(6));
  }
}

const ID = { init: 1, list: 2, call: 3 };
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(2);

const child = spawn(cmd, argv, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...extraEnv },
});

let buf = "";
let gotList = false;
let gotCall = false;
let sentInit = false;

function log(dir, frame) {
  const body = typeof frame === "string" ? frame : JSON.stringify(frame);
  console.log(`[${elapsed()}s] ${dir} ${body.length > 4000 ? body.slice(0, 4000) + ` …(+${body.length - 4000} chars)` : body}`);
}

function send(obj) {
  const line = JSON.stringify(obj);
  console.log(`[${elapsed()}s] >> SEND ${line.length > 4000 ? line.slice(0, 4000) + " …" : line}`);
  child.stdin.write(line + "\n");
}

child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); }
    catch { log("<< RAW (non-JSON)", line); continue; }
    log("<< RCVD", frame);

    if (frame.id === ID.init && frame.result) {
      sentInit = true;
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: ID.list, method: "tools/list", params: {} });
    } else if (frame.id === ID.list && (frame.result || frame.error)) {
      gotList = true;
      if (callName) {
        send({ jsonrpc: "2.0", id: ID.call, method: "tools/call", params: { name: callName, arguments: JSON.parse(callArgsJson) } });
      } else {
        finish(0);
      }
    } else if (frame.id === ID.call && (frame.result || frame.error)) {
      gotCall = true;
      finish(0);
    } else if (frame.id === ID.init && frame.error) {
      console.log(`[${elapsed()}s] !! initialize rejected by server`);
      finish(2);
    }
  }
});

child.stderr.on("data", (d) => {
  const s = d.toString().trim();
  if (s) console.log(`[${elapsed()}s] << STDERR ${s.slice(0, 2000)}`);
});

child.on("error", (e) => {
  console.log(`[${elapsed()}s] !! spawn error: ${e.message}`);
  finish(2);
});

child.on("exit", (code, sig) => {
  console.log(`[${elapsed()}s] !! server exited code=${code} sig=${sig}${sentInit ? "" : " (before/during handshake)"}`);
  finish(gotList || gotCall ? 0 : 2);
});

const timer = setTimeout(() => {
  console.log(`[${elapsed()}s] !! timeout — no tools/list (or call) result in 60s`);
  finish(3);
}, 60_000);

function finish(code) {
  clearTimeout(timer);
  try { child.kill("SIGTERM"); } catch {}
  process.exit(code);
}

// 1. initialize
send({
  jsonrpc: "2.0",
  id: ID.init,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hermes-mcp-probe", version: "0.1.0" },
  },
});

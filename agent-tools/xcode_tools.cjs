#!/usr/bin/env node
// xcode_tools.js — drive the Mac xcode-tools MCP server over the WS relay.
// ONE connection = ONE mcpbridge child; we reuse it across all calls in a plan
// (avoids the ~27s cold Xcode attach per connection).
//
// Usage:
//   node xcode_tools.js <plan.json>
// plan.json = [ {"name":"ToolName","args":{...},"timeout":ms?}, ... ]  (sequential)
// Prints a JSON array of {name, ok, result?, error?, timeout?} then exits.
//
// Requires ws in ./node_modules (present in this mcp-relay dir).
const { WebSocket } = require("ws");
const fs = require("fs");

const url = process.env.MCP_RELAY_URL;
const key = process.env.MCP_RELAY_KEY;
if (!url || !key) { console.error("MCP_RELAY_URL/KEY required"); process.exit(2); }

const planFile = process.argv[2];
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
const pending = {};
let idc = 100;
let ready = false;
const results = [];
let planIdx = 0;
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

function send(o) { ws.send(JSON.stringify(o)); }
function rpc(method, params, timeoutMs) {
  const id = idc++;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      if (pending[id]) { delete pending[id]; reject(new Error("timeout")); }
    }, timeoutMs || 180000);
    pending[id] = { resolve, reject, to };
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function runNext() {
  if (planIdx >= plan.length) {
    console.log(JSON.stringify(results, null, 2));
    ws.close();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  const call = plan[planIdx];
  const rec = { name: call.name, args: call.args || {} };
  try {
    const j = await rpc("tools/call", { name: call.name, arguments: call.args || {} }, call.timeout);
    rec.ok = !j.error;
    if (j.error) rec.error = j.error;
    if (j.result) rec.result = j.result;
    // unwrap content[0].text if it's a string (most xcode tools return text)
    if (rec.result && rec.result.content && Array.isArray(rec.result.content)) {
      const txt = rec.result.content.map(c => c.text || "").join("");
      rec.text = txt;
    }
  } catch (e) {
    rec.ok = false;
    rec.timeout = /timeout/.test(e.message);
    rec.error = String(e.message);
  }
  results.push(rec);
  console.error(`t=${el()}s [${planIdx + 1}/${plan.length}] ${call.name} -> ${rec.ok ? "ok" : ("ERR " + (rec.error || "timeout"))}`);
  planIdx++;
  runNext();
}

ws.on("open", () => {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hermes", version: "1.0" }
  }});
});
ws.on("message", (d) => {
  let j; try { j = JSON.parse(d.toString()); } catch (e) { return; }
  if (j.id === 1) {
    if (j.result) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      ready = true;
      console.error(`t=${el()}s init ok: ${JSON.stringify(j.result.serverInfo || {})}`);
      runNext();
    } else {
      console.error("INIT ERROR: " + JSON.stringify(j.error));
      process.exit(1);
    }
  } else if (j.id in pending) {
    const { resolve, reject, to } = pending[j.id];
    clearTimeout(to);
    delete pending[j.id];
    if (j.error) reject(new Error(j.error.message)); else resolve(j);
  }
});
ws.on("error", (e) => { console.error("WS ERROR: " + e.message); process.exit(1); });
ws.on("close", (c, p) => {
  if (!ready) { console.error("CLOSED before init: " + c + " " + String(p).slice(0, 80)); process.exit(1); }
});
// hard cap: 30 min
setTimeout(() => { console.error("GLOBAL TIMEOUT 30min"); process.exit(3); }, 1800000);

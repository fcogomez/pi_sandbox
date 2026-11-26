#!/usr/bin/env node
/**
 * fake-mcpbridge.mjs — test fixture: a minimal stdio MCP server (NDJSON
 * JSON-RPC 2.0) shaped like `xcrun mcpbridge` (see
 * scripts/mcpbridge-probe.mjs for the captured protocol ground truth).
 *
 *   initialize  -> result { protocolVersion: "2025-06-18",
 *                           serverInfo: { name: "fake-xcode", version: "0.0.1" },
 *                           capabilities: { tools: {} } }
 *   tools/list  -> 2 tools (EchoTool, PingTool)
 *   tools/call  -> echoes the call's arguments in content, tagged with this
 *                  process's pid (so tests can prove connection independence)
 *
 * Flags:
 *   --die-after N   exit(1) after N inbound lines have been processed
 *                   (for the child-exit-propagation test)
 *   --pidfile PATH  append this process's pid to PATH at startup (so tests
 *                   can observe which child the relay spawned, and verify it
 *                   was NOT spawned on a 401)
 *
 * Prints one line to stderr at startup (exercises the stderr -> relay log
 * file path and the exit close payload).
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
let dieAfter = Infinity;
let pidfile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--die-after") dieAfter = parseInt(args[++i], 10);
  else if (args[i] === "--pidfile") pidfile = args[++i];
}

if (pidfile) appendFileSync(pidfile, `${process.pid}\n`);
process.stderr.write(`fake-mcpbridge pid=${process.pid} ready\n`);

const TOOLS = [
  {
    name: "EchoTool",
    description: "Echoes its arguments (fixture).",
    inputSchema: { type: "object", properties: { tag: { type: "string" } }, additionalProperties: true },
  },
  {
    name: "PingTool",
    description: "Pings (fixture).",
    inputSchema: { type: "object", properties: { msg: { type: "string" } } },
  },
];

let inbound = 0;
let buf = "";

process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    inbound += 1;
    const resp = (payload) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id ?? null, ...payload }) + "\n");

    if (req.method === "initialize") {
      resp({
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "fake-xcode", version: "0.0.1" },
          capabilities: { tools: {} },
        },
      });
    } else if (req.method === "notifications/initialized") {
      // notification — no response
    } else if (req.method === "tools/list") {
      resp({ result: { tools: TOOLS } });
    } else if (req.method === "tools/call") {
      const argsOut = req.params?.arguments ?? {};
      resp({
        result: {
          content: [
            { type: "text", text: `echo ${JSON.stringify(argsOut)} [pid ${process.pid}]` },
          ],
        },
      });
    } else if (req.id !== undefined) {
      resp({ error: { code: -32601, message: `Method not found: ${req.method}` } });
    }

    if (inbound >= dieAfter) {
      process.stderr.write(`fake-mcpbridge pid=${process.pid} dying (die-after ${dieAfter})\n`);
      process.exit(1);
    }
  }
});

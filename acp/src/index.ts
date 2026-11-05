#!/usr/bin/env node
/**
 * ACP adapter entry point (tickets ACP-A1/A2/A3/B1).
 *
 * One code path, two transports (B1):
 *   - `acp` (no subcommand): serve ACP (JSON-RPC 2.0, newline-delimited) on
 *     stdio — behavior UNCHANGED from A1-A3.
 *   - `acp serve`: serve the SAME agent over WebSocket (bearer auth,
 *     per-connection PiAcpAgent) — see src/serve.ts.
 *
 * Both transports build the AgentSideConnection through createAgentStream()
 * from two Web Streams. Per ACP session a `pi --mode rpc` subprocess is
 * spawned (with the bundled extension loaded via `-e acp/pi-extension.ts`,
 * plus `ACP_FS_DELEGATION` / `ACP_GATED_TOOLS` env vars derived from the
 * loaded config) and bridged:
 *
 *   client -> initialize      -> handshake (protocolVersion, capabilities)
 *   client -> session/new     -> pi new_session + thinking-level defaults
 *   client -> session/prompt  -> pi prompt, streamed back as session/update
 *                                (agent_message_chunk / agent_thought_chunk,
 *                                tool_call / tool_call_update) plus final
 *                                usage and stop reason.
 *   pi extension select       -> session/request_permission (gated tools)
 *   pi extension input        -> fs/read_text_file (read delegation,
 *                                cancelled when the client lacks the
 *                                fs.readTextFile capability)
 *
 * Diagnostics go to stderr only; stdout carries ACP frames exclusively
 * (in serve mode, WS text messages do).
 */

import { realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { AgentSideConnection, type AnyMessage } from "@agentclientprotocol/sdk";
import { PI_EXTENSION_PATH, PiAcpAgent } from "./acp-server.js";
import { createAgentStream } from "./serve.js";
import { loadConfig } from "./config.js";

function main(): void {
  const config = loadConfig();
  // The adapter spawns pi with `-e <extensionPath>` and sets
  // ACP_FS_DELEGATION / ACP_GATED_TOOLS on the child env from this config.
  const agent = new PiAcpAgent({
    config,
    extensionPath: PI_EXTENSION_PATH,
    log: (m) => process.stderr.write(`[acp] ${m}\n`),
  });

  // stdio <-> Web streams (the ACP SDK speaks Web Streams).
  const out = new WritableStream<Uint8Array>({
    write: (chunk) => {
      process.stdout.write(Buffer.from(chunk));
    },
  });
  const inStream = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = createAgentStream(out, inStream);
  const connection = new AgentSideConnection((conn) => agent.attach(conn), stream);
  void connection.closed.finally(() => process.exit(0));

  // A3 orphan protection: on SIGINT/SIGTERM/exit, close every managed pi
  // child before the process dies. (Session-map entries are deliberately
  // NOT deleted on shutdown — that is what makes sessions loadable after a
  // restart.)
  const shutdown = (reason: string): void => {
    process.stderr.write(`[acp] ${reason}: shutting down (closing pi children)\n`);
    agent.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT received"));
  process.on("SIGTERM", () => shutdown("SIGTERM received"));
  process.on("exit", () => agent.shutdown());
}

/**
 * Dispatch only when this module is the process's direct entry point
 * (`node dist/index.js [serve]`). Importing the module (unit tests, and
 * serve.ts itself) must NOT start the stdio server.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  if (process.argv[2] === "serve") {
    // B1: WebSocket transport. PI_ACP_API_KEY is enforced inside
    // startAcpServer (refuses to start open); a startup failure exits
    // non-zero before/without serving.
    void import("./serve.js")
      .then((m) =>
        m.startAcpServer({
          config: loadConfig(),
          log: (msg) => process.stderr.write(`[acp] ${msg}\n`),
        }),
      )
      .catch((err: unknown) => {
        process.stderr.write(`[acp] ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
  } else {
    main();
  }
}

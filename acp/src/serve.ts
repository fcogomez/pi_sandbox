/**
 * ACP network mode (ticket ACP-B1): WebSocket transport for the SAME agent
 * stdio mode serves (`PiAcpAgent`, src/acp-server.ts).
 *
 * Framing: one ACP JSON-RPC 2.0 record per WS **text** message (NDJSON over
 * WebSocket — the SDK's ndJsonStream still does the byte-level split; each
 * incoming WS text message is normalized to end with LF).
 *
 * Security (mirrors mcp/server.js exactly):
 *   - PI_ACP_API_KEY is REQUIRED. If empty/absent, `startAcpServer` logs
 *     FATAL and throws BEFORE opening any socket. No open mode, no fallback.
 *   - The WS `upgrade` must carry `Authorization: Bearer <key>`; compared
 *     with crypto.timingSafeEqual (length-safe). Missing header, non-Bearer
 *     scheme, or wrong token -> HTTP 401 and the socket is NOT upgraded.
 *
 * Per connection: its OWN PiAcpAgent (fresh sessions, isolated pi children);
 * on WS close the agent is shut down (closes that connection's pi children) —
 * the same isolation stdio gets from one agent per process.
 *
 * Bind: PI_ACP_HOST (default 127.0.0.1):PI_ACP_PORT (default 3123).
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  AgentSideConnection,
  ndJsonStream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { PI_EXTENSION_PATH, PiAcpAgent } from "./acp-server.js";
import type { AcpConfig } from "./config.js";
import type { PiSpawner } from "./pi-rpc.js";

/**
 * Shared agent-stream helper (B1 "one code path, two transports").
 *
 * Wraps the ACP SDK's ndJsonStream over the given Web Streams. BOTH the stdio
 * mode (src/index.ts main()) and the `serve` mode (attachAgent below, one
 * call per WS connection) build their AgentSideConnection from the pair
 * returned here — the transport (stdout/stdin vs. ws.send/on("message")) is
 * the only difference.
 *
 * Lives in this (leaf) module on purpose: it must NOT be imported back into
 * src/index.ts's module graph from index.ts, or esbuild code-splitting
 * hoists the entry's top-level dispatch into a chunk and the binary's
 * argv-based dispatch stops matching `import.meta.url`.
 */
export function createAgentStream(
  out: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): { writable: WritableStream<AnyMessage>; readable: ReadableStream<AnyMessage> } {
  return ndJsonStream(out, input) as {
    writable: WritableStream<AnyMessage>;
    readable: ReadableStream<AnyMessage>;
  };
}

export interface AcpServeOptions {
  /** Loaded AcpConfig (thinkingLevel/gatedTools/fsDelegation/sessionMapPath). */
  config?: AcpConfig;
  /** pi extension loaded via `-e` (default: the bundled pi-extension.ts). */
  extensionPath?: string;
  /** Spawner seam for the pi subprocess (tests inject an in-process fake pi). */
  spawner?: PiSpawner;
  /** Diagnostics sink (default: stderr). */
  log?: (message: string) => void;
  /** Bind host (default: env PI_ACP_HOST, then "127.0.0.1"). */
  host?: string;
  /** Bind port; 0 = ephemeral (default: env PI_ACP_PORT, then 3123). */
  port?: number;
}

export interface AcpServer {
  /** The actually bound port (differs from the requested one when 0). */
  readonly port: number;
  /** Resolves once the socket is bound and listening. */
  readonly ready: Promise<void>;
  /** Close the listener and terminate all open connections. */
  close(): Promise<void>;
}

/** The exact refuse-to-start message (asserted by tests, logged to stderr). */
export const FATAL_NO_KEY =
  "FATAL: PI_ACP_API_KEY is not set; the ACP server refuses to start open.";

/**
 * Constant-time Bearer token compare, exactly like mcp/server.js checkAuth:
 * compare lengths first (timingSafeEqual throws on length mismatch), then
 * timingSafeEqual the bytes.
 */
function timingSafeKey(provided: string, key: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function startAcpServer(options: AcpServeOptions = {}): AcpServer {
  const log = options.log ?? ((m) => process.stderr.write(`[acp] ${m}\n`));

  // REFUSE TO START OPEN: no key -> log FATAL + throw before any socket.
  // (The process-level exit(1) is the caller's job — the binary's `serve`
  // subcommand catches this and exits non-zero; tests catch the throw.)
  const key = process.env.PI_ACP_API_KEY ?? "";
  if (!key) {
    log(FATAL_NO_KEY);
    throw new Error(FATAL_NO_KEY);
  }

  const host = options.host ?? process.env.PI_ACP_HOST ?? "127.0.0.1";
  const port = parseInt(String(options.port ?? process.env.PI_ACP_PORT ?? "3123"), 10);
  const extensionPath = options.extensionPath ?? PI_EXTENSION_PATH;

  const wss = new WebSocketServer({ noServer: true });
  const server = createHttpServer((req, res) => {
    // This endpoint is WebSocket-only.
    res.writeHead(404, { "Content-Type": "text/plain" }).end("ACP server (WebSocket only)\n");
  });

  // Bearer auth on the upgrade event: 401 + no upgrade unless the key matches.
  server.on("upgrade", (req, socket, head) => {
    const auth = req.headers.authorization ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeKey(m[1], key)) {
      log(`auth failed from ${req.socket.remoteAddress ?? "?"}; rejected with 401`);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachAgent(ws));
  });

  /** One agent per WS connection (fresh sessions, isolated pi children). */
  function attachAgent(ws: WebSocket): void {
    const agent = new PiAcpAgent({
      config: options.config,
      extensionPath,
      spawner: options.spawner,
      log,
    });

    // Outgoing: each NDJSON frame encoded by the SDK is sent as ONE WS text
    // message (one ACP JSON-RPC record per message).
    const out = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.from(chunk).toString("utf8"));
        }
      },
    });

    // Incoming: each WS text message becomes a chunk for the SDK's
    // ndJsonStream, normalized to end with LF (tolerant of clients that do
    // not terminate lines). The SDK does the line splitting — no readline.
    let paused = false;
    const inNode = new Readable({
      read() {
        if (paused) {
          paused = false;
          ws.resume();
        }
      },
    });
    ws.on("message", (data) => {
      const buf = toBuffer(data);
      const chunk = new Uint8Array(buf.byteLength + 1);
      chunk.set(buf, 0);
      chunk[buf.byteLength] = 0x0a; // '\n'
      const ok = inNode.push(chunk);
      if (!ok && !paused) {
        // Backpressure: stop reading the socket until Node drains.
        paused = true;
        ws.pause();
      }
    });
    const inStream = Readable.toWeb(inNode) as ReadableStream<Uint8Array>;

    const teardown = (reason: string): void => {
      try {
        inNode.push(null);
      } catch {
        // stream already ended
      }
      log(`connection ${reason}; shutting down per-connection agent (closing pi children)`);
      agent.shutdown();
    };
    ws.on("close", () => teardown("closed"));
    ws.on("error", () => teardown("errored"));

    // THE SAME code path as stdio mode (src/index.ts main()): build the
    // AgentSideConnection from two Web Streams via createAgentStream().
    const stream = createAgentStream(out, inStream);
    const connection = new AgentSideConnection((conn) => agent.attach(conn), stream);
    void connection.closed.finally(() => agent.shutdown());
  }

  let actualPort = port;
  const ready = new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      log(`server error: ${err.message}`);
      reject(err);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      log(`ACP server listening on ws://${host}:${actualPort} (bearer auth required)`);
      resolve();
    });
  });

  return {
    get port() {
      return actualPort;
    },
    ready,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

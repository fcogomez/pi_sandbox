/**
 * Offline smoke test (ticket ACP-B2): `initialize` -> `session/new` ->
 * `session/prompt` round-trip over BOTH transports, with NO real pi, NO LLM,
 * NO vLLM, NO external network.
 *
 * Stdio mode: in-memory TransformStreams + the SDK client (the pattern the
 * other unit tests use) — confirms the agent core works over the stdio pipe.
 *
 * WS mode: a REAL `startAcpServer` on an ephemeral localhost port (the B1
 * server, bearer auth, serve.ts stream build + LF normalization +
 * backpressure), driven by a real `ws` client that speaks raw NDJSON JSON-RPC
 * — the same wire format the Mac-side proxy (C1) and the TCK-bridge (item 1b)
 * will use. The spawner seam injects FakePi, so the pi child is in-process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClientSideConnection,
  type AnyMessage,
  type ContentChunk,
  type SessionUpdate,
  type TextContent,
} from "@agentclientprotocol/sdk";
import { WebSocket } from "ws";
import { PiAcpAgent } from "../src/acp-server.js";
import { startAcpServer } from "../src/serve.js";
import type { AcpConfig } from "../src/config.js";
import { FakePi } from "./fake-pi-rpc.js";
import { makeAcpHarness, type AcpHarness } from "./fake-acp-client.js";

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: {} },
  clientInfo: { name: "smoke-client", version: "0.1.0" },
};

/* ---------------------------------------------------------------- stdio */

test("smoke/stdio: initialize + session/new + session/prompt round-trip", async () => {
  const fake = new FakePi({
    textDeltas: ["Smoke: ", "OK"],
    usage: { input: 3, output: 4 },
  });
  const h: AcpHarness = makeAcpHarness({
    config: { thinkingLevel: "medium" } as AcpConfig,
    fake,
  });
  try {
    const init = await h.conn.initialize(INIT_PARAMS);
    assert.equal(init.protocolVersion, 1);
    assert.ok((init.agentInfo?.name ?? "").length > 0, "agentInfo.name present");

    const ns = await h.conn.newSession({ cwd: "/tmp/smoke", mcpServers: [] });
    assert.ok(typeof ns.sessionId === "string" && ns.sessionId.length > 0);
    assert.equal(h.fake.commandsOf("new_session").length, 1);

    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "smoke" }],
    });
    assert.equal(res.stopReason, "end_turn");
    // The streamed text reassembles from the session/update chunks. Same
    // casting pattern as acp.test.ts (the union has no `content` property).
    const chunkText = (c: SessionUpdate): string =>
      (c as ContentChunk).content.type === "text"
        ? ((c as ContentChunk).content as TextContent).text
        : "";
    const text = h.client.updates
      .map((u) => u.update)
      .filter((c) => c.sessionUpdate === "agent_message_chunk")
      .map(chunkText)
      .join("");
    assert.equal(text, "Smoke: OK");
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------- WS */

/** Minimal raw-NDJSON JSON-RPC client over a real ws connection. */
class WsJsonRpc {
  private id = 0;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly notifications: unknown[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.buffer += data.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
          else p.resolve(msg.result);
        } else if (msg.method) {
          this.notifications.push(msg);
        }
      }
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e) => reject(e));
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }, 15000);
    });
  }

  close(): void {
    this.ws.close();
  }
}

test("smoke/ws: initialize + session/new + session/prompt over a real WS server", async () => {
  const fake = new FakePi({
    textDeltas: ["WS smoke: ", "OK"],
    usage: { input: 5, output: 6 },
  });

  const prevKey = process.env.PI_ACP_API_KEY;
  process.env.PI_ACP_API_KEY = "smoke-test-key-not-for-prod";
  const server = startAcpServer({
    config: { thinkingLevel: "medium" } as AcpConfig,
    spawner: () => fake, // seam: per-connection agent spawns the FAKE pi
    port: 0, // ephemeral
    host: "127.0.0.1",
    log: () => {},
  });
  try {
    await server.ready;

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, {
      headers: { Authorization: `Bearer ${process.env.PI_ACP_API_KEY}` },
    });
    const rpc = new WsJsonRpc(ws);
    await rpc.ready();

    const init = (await rpc.request("initialize", INIT_PARAMS)) as {
      protocolVersion: number;
      agentInfo?: { name?: string };
      agentCapabilities?: { loadSession?: boolean };
    };
    assert.equal(init.protocolVersion, 1);
    assert.ok((init.agentInfo?.name ?? "").length > 0, "agentInfo.name over WS");
    assert.equal(init.agentCapabilities?.loadSession, true, "loadSession advertised over WS");

    const ns = (await rpc.request("session/new", {
      cwd: "/tmp/smoke",
      mcpServers: [],
    })) as { sessionId: string };
    assert.ok(ns.sessionId.length > 0, "session/new over WS");
    assert.equal(h0(fake), 1, "fake pi got new_session over WS");

    const res = (await rpc.request("session/prompt", {
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "smoke" }],
    })) as { stopReason: string };
    assert.equal(res.stopReason, "end_turn", "prompt completes over WS");

    // A session/update notification crossed the wire (the streamed text).
    await pollFor(
      () =>
        rpc.notifications.some((n) => {
          const u = (n as { params?: { update?: { sessionUpdate?: string } } })
            .params?.update;
          return u?.sessionUpdate === "agent_message_chunk";
        }),
      5000,
    );
    rpc.close();
  } finally {
    process.env.PI_ACP_API_KEY = prevKey;
    await server.close();
  }
});

/** h0: count new_session commands the fake pi saw (helper keeps the test tidy). */
function h0(fake: FakePi): number {
  return fake.commandsOf("new_session").length;
}

async function pollFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("pollFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

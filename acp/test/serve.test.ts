import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import { FATAL_NO_KEY, createAgentStream, startAcpServer, type AcpServer } from "../src/serve.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * Ticket ACP-B1: `acp serve` — ACP over WebSocket with bearer auth.
 *
 * Fully offline: the server runs on an EPHEMERAL port (port 0) bound to
 * 127.0.0.1, the agent uses the in-process FakePi via the spawner seam (NO
 * real pi binary, NO LLM, NO network host), and the client is a real `ws`
 * WebSocket in the same process.
 */

const TEST_KEY = "acp-b1-test-key-0123456789abcdef01234567";
const TMP = mkdtempSync(join(tmpdir(), "acp-serve-"));

let server: AcpServer;
let prevKey: string | undefined;
const fake = new FakePi({ sessionFile: join(TMP, "fake-session.jsonl") });

before(async () => {
  prevKey = process.env.PI_ACP_API_KEY;
  process.env.PI_ACP_API_KEY = TEST_KEY;
  server = startAcpServer({
    config: { thinkingLevel: "medium", sessionMapPath: join(TMP, "sessions.json") },
    spawner: () => fake, // seam: the per-connection agent spawns the FAKE pi
    log: () => {},
    port: 0, // ephemeral port — no port collisions
    host: "127.0.0.1",
  });
  await server.ready;
});

after(async () => {
  await server.close();
  if (prevKey === undefined) delete process.env.PI_ACP_API_KEY;
  else process.env.PI_ACP_API_KEY = prevKey;
});

/** Minimal raw WS ACP client: one JSON-RPC record per WS text message. */
interface WsClient {
  ws: WebSocket;
  updates: SessionNotification[];
  send(obj: unknown): void;
  request<T>(id: number, method: string, params: unknown): Promise<T>;
  close(): Promise<void>;
}

/** Connect; resolves on WS open, rejects with { statusCode } on an HTTP 4xx/5xx. */
function connect(url: string, headers?: Record<string, string>): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : {});
    const pending = new Map<
      number,
      { timer: NodeJS.Timeout; res: (v: unknown) => void; rej: (e: Error) => void }
    >();
    const updates: SessionNotification[] = [];
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(err);
    };

    const client: WsClient = {
      ws,
      updates,
      send: (obj) => ws.send(JSON.stringify(obj)),
      request: <T2 = unknown>(id: number, method: string, params: unknown) =>
        new Promise<T2>((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`timeout waiting for ${method} response`));
          }, 10_000);
          pending.set(id, { timer, res: res as (v: unknown) => void, rej });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        }),
      close: async () => {
        await new Promise<void>((r) => {
          ws.on("close", () => r());
          ws.close();
        });
      },
    };

    ws.on("unexpected-response", (_req, res) => {
      const err = new Error(`unexpected HTTP status ${res.statusCode}`) as Error & {
        statusCode?: number;
      };
      err.statusCode = res.statusCode;
      fail(err);
    });
    ws.on("open", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });
    ws.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    ws.on("message", (data: RawData) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const msg = JSON.parse(trimmed) as AnyMessage;
        const id = (msg as { id?: unknown }).id;
        if (typeof id === "number") {
          const p = pending.get(id);
          if (p) {
            pending.delete(id);
            clearTimeout(p.timer);
            const errField = (msg as { error?: { message?: string } }).error;
            if (errField) p.rej(new Error(`JSON-RPC error: ${errField.message ?? "unknown"}`));
            else p.res((msg as { result?: unknown }).result);
          }
        } else if ((msg as { method?: string }).method === "session/update") {
          updates.push((msg as { params: SessionNotification }).params);
        }
      }
    });
  });
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: {} },
  clientInfo: { name: "ws-test-client", version: "0.1.0" },
};

test("auth accepted: full initialize + session/new + session/prompt round-trip over WS", async () => {
  const c = await connect(`ws://127.0.0.1:${server.port}`, {
    Authorization: `Bearer ${TEST_KEY}`,
  });
  try {
    // 1) initialize handshake over the WebSocket.
    const init = await c.request<{ protocolVersion: number; agentInfo?: { name?: string } }>(
      1,
      "initialize",
      INIT_PARAMS,
    );
    assert.equal(init.protocolVersion, 1, "initialize response must carry protocolVersion");
    assert.ok(init.agentInfo?.name, "agentInfo must be present");

    // 2) session/new (the per-connection agent spawns the FAKE pi).
    const ns = await c.request<{ sessionId: string }>(2, "session/new", {
      cwd: "/tmp/work",
      mcpServers: [],
    });
    assert.ok(typeof ns.sessionId === "string" && ns.sessionId.length > 0);
    assert.equal(fake.commandsOf("new_session").length, 1, "fake pi got new_session");

    // 3) session/prompt: streamed updates + final PromptResponse over WS.
    const promptRes = await c.request<{ stopReason: string; usage?: { totalTokens?: number } }>(
      3,
      "session/prompt",
      {
        sessionId: ns.sessionId,
        prompt: [{ type: "text", text: "What is the answer?" }],
      },
    );
    assert.equal(promptRes.stopReason, "end_turn");
    assert.equal(promptRes.usage?.totalTokens, 33, "usage must arrive in the WS response");

    const kinds = c.updates.map((u) => u.update.sessionUpdate);
    assert.ok(kinds.includes("agent_message_chunk"), "must stream agent_message_chunk over WS");
    assert.ok(
      c.updates.length >= 1,
      "session/update notifications must arrive over WS",
    );
    const text = c.updates
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => {
        const content = (u.update as { content?: { type: string; text?: string } }).content;
        return content && content.type === "text" ? content.text : "";
      })
      .join("");
    assert.equal(text, "Hello world", "fake pi text deltas must stream through the WS");
    for (const u of c.updates) {
      assert.equal(u.sessionId, ns.sessionId, "updates must carry the session id");
    }
  } finally {
    await c.close();
  }
});

test("auth rejected (missing key): 401, WS does not open", async () => {
  let err: (Error & { statusCode?: number }) | undefined;
  await assert.rejects(
    connect(`ws://127.0.0.1:${server.port}`), // no Authorization header
    (e: Error & { statusCode?: number }) => {
      err = e;
      return e.statusCode === 401;
    },
    "expected HTTP 401 when the Authorization header is missing",
  );
  assert.equal(err?.statusCode, 401);
});

test("auth rejected (wrong key): 401, WS does not open", async () => {
  let err: (Error & { statusCode?: number }) | undefined;
  await assert.rejects(
    connect(`ws://127.0.0.1:${server.port}`, {
      Authorization: "Bearer wrongkey-wrongkey-wrongkey-wrongkey0",
    }),
    (e: Error & { statusCode?: number }) => {
      err = e;
      return e.statusCode === 401;
    },
    "expected HTTP 401 for a wrong bearer key",
  );
  assert.equal(err?.statusCode, 401);
});

test("refuses to start without a key: FATAL logged, throws, no socket opened", () => {
  const saved = process.env.PI_ACP_API_KEY;
  delete process.env.PI_ACP_API_KEY;
  const logs: string[] = [];
  try {
    assert.throws(
      () => startAcpServer({ log: (m) => logs.push(m), port: 0 }),
      (e: Error) => e.message === FATAL_NO_KEY,
      "startAcpServer must throw the FATAL message when PI_ACP_API_KEY is unset",
    );
    assert.ok(
      logs.some((l) => l === FATAL_NO_KEY),
      "the FATAL log line must be written before any socket is opened",
    );
  } finally {
    process.env.PI_ACP_API_KEY = saved;
  }
});

test("one code path: stdio main() and serve() share createAgentStream", async () => {
  // The shared helper frames NDJSON in BOTH directions — exactly the wiring
  // index.ts main() uses for stdout/stdin and serve.ts uses per WS connection.
  const sent: Buffer[] = [];
  const out = new WritableStream<Uint8Array>({
    write: (c) => {
      sent.push(Buffer.from(c));
    },
  });
  const inNode = new Readable({ read() {} });
  const stream = createAgentStream(out, Readable.toWeb(inNode) as ReadableStream<Uint8Array>);

  // agent -> client direction: one AnyMessage in, one NDJSON line out.
  await stream.writable
    .getWriter()
    .write({ jsonrpc: "2.0", id: 42, method: "initialize", params: {} } as AnyMessage);
  const bytes = Buffer.concat(sent).toString("utf8");
  assert.ok(bytes.endsWith("\n"), "frame must be LF-terminated");
  const rec = JSON.parse(bytes) as { method?: string; id?: number };
  assert.equal(rec.method, "initialize");
  assert.equal(rec.id, 42);

  // client -> agent direction: one NDJSON line in, one AnyMessage out.
  inNode.push(
    Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 42, result: { protocolVersion: 1 } }) + "\n",
    ),
  );
  const reader = stream.readable.getReader();
  const { value } = await reader.read();
  assert.equal((value as { id?: number }).id, 42, "the readable side must decode the frame");
  reader.releaseLock();
});

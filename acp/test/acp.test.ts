import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentSideConnection,
  ClientSideConnection,
  type AgentSideConnection as AgentSideConnectionType,
  type AnyMessage,
  type Client,
  type ContentChunk,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigSelect,
  type SessionNotification,
  type SessionUpdate,
  type TextContent,
} from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "../src/acp-server.js";
import type { AcpConfig } from "../src/config.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * Unit tests for the ACP adapter (ticket ACP-A1).
 *
 * The ACP client side is driven over an in-memory pair of TransformStreams
 * (NDJSON handled by the SDK). The pi side is an in-process FakePi that
 * speaks the real `pi --mode rpc` JSONL protocol. NO real pi, NO LLM, NO
 * vLLM, NO network — fully offline.
 */

/** Minimal ACP client under test: records session/update notifications. */
class TestClient implements Client {
  readonly updates: SessionNotification[] = [];

  async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // A1 must never request permissions (that's A2).
    throw new Error("requestPermission is out of scope in A1");
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

interface Harness {
  agent: PiAcpAgent;
  client: TestClient;
  conn: ClientSideConnection;
  fake: FakePi;
  close: () => Promise<void>;
}

function makeHarness(options?: { config?: AcpConfig; fake?: FakePi }): Harness {
  const fake = options?.fake ?? new FakePi();
  const agent = new PiAcpAgent({
    config: options?.config ?? { thinkingLevel: "medium" },
    spawner: () => fake, // seam: the adapter spawns the FAKE pi, never a real one
    log: () => {},
  });

  // agent writes -> client reads, client writes -> agent reads.
  const agentOut = new TransformStream<AnyMessage>();
  const clientOut = new TransformStream<AnyMessage>();
  const client = new TestClient();

  const agentStream = {
    writable: agentOut.writable as WritableStream<AnyMessage>,
    readable: clientOut.readable as ReadableStream<AnyMessage>,
  };
  const clientStream = {
    writable: clientOut.writable as WritableStream<AnyMessage>,
    readable: agentOut.readable as ReadableStream<AnyMessage>,
  };

  const agentConn: AgentSideConnectionType = new AgentSideConnection(
    (conn) => agent.attach(conn),
    agentStream,
  );
  const conn = new ClientSideConnection(() => client, clientStream);

  return {
    agent,
    client,
    conn,
    fake,
    close: async () => {
      agent.shutdown();
      void agentConn.closed;
      void conn.closed;
    },
  };
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: {} },
  clientInfo: { name: "test-client", version: "0.1.0" },
};

test("initialize handshake: protocolVersion negotiated, capabilities + info present", async () => {
  const h = makeHarness();
  try {
    const res = await h.conn.initialize(INIT_PARAMS);

    assert.equal(res.protocolVersion, 1);
    assert.ok(res.agentInfo, "agentInfo must be present");
    assert.ok(res.agentInfo.name.length > 0, "agentInfo.name must be non-empty");
    assert.ok(typeof res.agentInfo.version === "string");
    assert.ok(res.agentCapabilities, "agentCapabilities must be present");

    // A3: session persistence is implemented — loadSession IS advertised
    // (this assertion was "loadSession is A3" while it was still deferred).
    assert.equal(res.agentCapabilities.loadSession, true, "loadSession advertised since A3");
    assert.ok(
      res.agentCapabilities.sessionCapabilities === undefined ||
        !("delete" in (res.agentCapabilities.sessionCapabilities ?? {})),
      "no session persistence capability claims in A1",
    );

    // The adapter must have captured the client's capabilities (the SDK
    // normalizes omitted boolean fields to false before delivery).
    assert.ok(h.agent.clientCapabilities, "client capabilities must be captured");
    assert.equal(h.agent.clientCapabilities?.fs?.readTextFile, false);
  } finally {
    await h.close();
  }
});

test("session/new: reports available thinking levels, default medium applied", async () => {
  const h = makeHarness(); // config default: medium
  try {
    await h.conn.initialize(INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });

    assert.ok(typeof ns.sessionId === "string" && ns.sessionId.length > 0);

    assert.ok(h.fake.commandsOf("new_session").length === 1, "fake pi got new_session");

    const opt = ns.configOptions?.find((o) => o.id === "thinking_level");
    assert.ok(opt, "session info must report a thinking_level config option");
    assert.equal(opt!.type, "select");
    const select = opt as SessionConfigSelect;
    assert.equal(select.currentValue, "medium", "default medium must be applied");
    assert.deepEqual(
      (select.options as Array<{ value: string }>).map((o) => o.value),
      ["off", "low", "medium", "high"],
      "available levels from the fake model must be reported",
    );

    // Default already matches the fake's initial level -> no set command sent.
    assert.equal(h.fake.commandsOf("set_thinking_level").length, 0);
  } finally {
    await h.close();
  }
});

test("session/new: configured thinkingLevel override (high) is honored", async () => {
  const h = makeHarness({ config: { thinkingLevel: "high" } });
  try {
    await h.conn.initialize(INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });

    const opt = ns.configOptions?.find((o) => o.id === "thinking_level") as SessionConfigSelect;
    assert.ok(opt, "thinking_level option must be present");
    assert.equal(opt.currentValue, "high", "configured override must be applied");

    assert.deepEqual(
      h.fake.commandsOf("set_thinking_level").map((c) => c.level),
      ["high"],
      "fake pi must receive set_thinking_level with the override",
    );
  } finally {
    await h.close();
  }
});

test("session/prompt: streams thought + message chunks, final usage, stop reason", async () => {
  const fake = new FakePi({
    thinkingDeltas: ["Hmmm, ", "let me reason."],
    textDeltas: ["Answer: ", "42"],
    usage: { input: 5, output: 7, thought: 2 },
  });
  const h = makeHarness({ fake });
  try {
    await h.conn.initialize(INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });

    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "What is the answer?" }],
    });

    assert.equal(res.stopReason, "end_turn");
    assert.deepEqual(res.usage, {
      totalTokens: 12,
      inputTokens: 5,
      outputTokens: 7,
      thoughtTokens: 2,
    });

    const chunks = h.client.updates.map((u) => u.update);
    const chunkText = (c: SessionUpdate): string =>
      (c as ContentChunk).content.type === "text"
        ? ((c as ContentChunk).content as TextContent).text
        : "";
    const thoughtChunks = chunks.filter((c) => c.sessionUpdate === "agent_thought_chunk");
    const messageChunks = chunks.filter((c) => c.sessionUpdate === "agent_message_chunk");

    assert.ok(thoughtChunks.length >= 1, "must stream agent_thought_chunk(s)");
    assert.ok(messageChunks.length >= 1, "must stream agent_message_chunk(s)");

    assert.equal(
      thoughtChunks.map(chunkText).join(""),
      "Hmmm, let me reason.",
    );
    assert.equal(
      messageChunks.map(chunkText).join(""),
      "Answer: 42",
    );

    // Verified pi order: thinking deltas precede text deltas within the run.
    assert.equal(chunks[0].sessionUpdate, "agent_thought_chunk");

    // All notifications carry the session id.
    for (const u of h.client.updates) {
      assert.equal(u.sessionId, ns.sessionId);
    }

    // The prompt command reached the fake with the joined text.
    assert.deepEqual(
      h.fake.commandsOf("prompt").map((c) => c.text),
      ["What is the answer?"],
    );
  } finally {
    await h.close();
  }
});

test("thinking controls: set / get_state / get_available / cycle map onto pi RPC", async () => {
  const h = makeHarness();
  try {
    await h.conn.initialize(INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });

    // set_thinking_level("high") -> fake receives set_thinking_level {level:"high"}
    await h.agent.setThinkingLevel(ns.sessionId, "high");
    assert.deepEqual(
      h.fake.commandsOf("set_thinking_level").map((c) => c.level),
      ["high"],
    );

    // get_state() returns what the fake reported (incl. current level)
    const state = await h.agent.getSessionState(ns.sessionId);
    assert.equal(state.thinkingLevel, "high");
    assert.equal(state.sessionId, "fake-pi-session-1");

    // get_available_thinking_levels() returns the fake's level list
    const levels = await h.agent.getAvailableThinkingLevels(ns.sessionId);
    assert.deepEqual(levels, ["off", "low", "medium", "high"]);

    // cycle_thinking_level() returns the new level (high -> wraps to off)
    const cycled = await h.agent.cycleThinkingLevel(ns.sessionId);
    assert.equal(cycled, "off");
    assert.equal(h.fake.commandsOf("cycle_thinking_level").length, 1);

    const stateAfter = await h.agent.getSessionState(ns.sessionId);
    assert.equal(stateAfter.thinkingLevel, "off");
  } finally {
    await h.close();
  }
});

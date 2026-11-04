import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { argsSummary, piToolEventToAcpUpdate, piToolKind } from "../src/tool-mapping.js";
import type { PiRecord } from "../src/pi-rpc.js";
import { DEFAULT_INIT_PARAMS, makeAcpHarness, waitFor } from "./fake-acp-client.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * Tool call lifecycle tests (ticket ACP-A2, tests 1-2).
 *
 * Fake in-process pi only: NO real pi, NO LLM, NO vLLM, NO network.
 */

const TOOL_EVENTS = (u: SessionUpdate[]): ToolUpdate[] =>
  u.filter(
    (x) => x.sessionUpdate === "tool_call" || x.sessionUpdate === "tool_call_update",
  ) as unknown as ToolUpdate[];

/** Structural view of tool_call / tool_call_update updates for assertions. */
interface ToolUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  kind?: string;
  status?: string;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string }>;
  content?: Array<{ type: string; content: unknown }>;
}

test("tool kind + args summary mapping (locked A2 table)", () => {
  assert.equal(piToolKind("read"), "read");
  assert.equal(piToolKind("write"), "edit");
  assert.equal(piToolKind("edit"), "edit");
  assert.equal(piToolKind("bash"), "execute");
  assert.equal(piToolKind("grep"), "search");
  assert.equal(piToolKind("find"), "search");
  assert.equal(piToolKind("ls"), "search");
  assert.equal(piToolKind("mystery_tool"), "other");

  assert.equal(argsSummary("bash", { command: "ls -la" }), "ls -la");
  assert.equal(argsSummary("read", { path: "/tmp/a.txt" }), "/tmp/a.txt");
  assert.equal(argsSummary("write", { path: "/tmp/b.txt", content: "x" }), "/tmp/b.txt");
  assert.equal(argsSummary("grep", { pattern: "foo", path: "src" }), "foo src");
  assert.equal(argsSummary("grep", { pattern: "bar" }), "bar");
  const long = JSON.stringify({ a: "x".repeat(200) });
  assert.equal(argsSummary("mystery", { a: "x".repeat(200) }).length, 80);
  assert.ok(argsSummary("mystery", { a: "x".repeat(200) }).startsWith(long.slice(0, 80)));

  // Pure mapping of the three pi tool events.
  const start = piToolEventToAcpUpdate(
    { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/f" } },
    "t1",
    "read",
    { path: "/f" },
  );
  assert.equal(start?.sessionUpdate, "tool_call");
  assert.deepEqual((start as { locations?: unknown }).locations, [{ path: "/f" }]);

  const update = piToolEventToAcpUpdate(
    { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "partial" }] } },
    "t1",
    "read",
    { path: "/f" },
  );
  assert.equal((update as { status?: string }).status, "in_progress");
  assert.deepEqual((update as { content?: unknown }).content, [
    { type: "content", content: { type: "text", text: "partial" } },
  ]);

  const end = piToolEventToAcpUpdate(
    { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "done" }] }, isError: false },
    "t1",
    "read",
    { path: "/f" },
  );
  assert.equal((end as { status?: string }).status, "completed");

  assert.equal(piToolEventToAcpUpdate({ type: "agent_start" } as PiRecord, "t1", "read", {}), null);
});

test("session/prompt (with-tool): tool_call in_progress -> update -> completed, bash maps to execute", async () => {
  const fake = new FakePi({
    promptBehavior: "with-tool",
    tool: {
      toolCallId: "tc-1",
      toolName: "bash",
      args: { command: "ls -la" },
      partialText: "total 1\n",
      resultText: "total 1\nfile1",
    },
  });
  const h = makeAcpHarness({ fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "list the files" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // The pi-RPC pipe and the ACP notification pipe are independent: wait
    // for the final tool_call_update to land at the client.
    await waitFor(() =>
      TOOL_EVENTS(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const [start, upd, end] = TOOL_EVENTS(h.client.updates.map((u) => u.update));
    assert.equal(start.sessionUpdate, "tool_call");
    assert.equal(start.toolCallId, "tc-1");
    assert.equal(start.kind, "execute", "bash must map to ToolKind execute");
    assert.equal(start.status, "in_progress");
    assert.equal(start.title, "bash: ls -la");
    assert.deepEqual(start.rawInput, { command: "ls -la" });
    assert.equal(start.locations, undefined, "bash has no path -> no locations");

    assert.equal(upd.toolCallId, "tc-1");
    assert.equal(upd.status, "in_progress");
    assert.deepEqual(upd.content, [
      { type: "content", content: { type: "text", text: "total 1\n" } },
    ]);

    assert.equal(end.toolCallId, "tc-1");
    assert.equal(end.status, "completed");
    assert.deepEqual(end.content, [
      { type: "content", content: { type: "text", text: "total 1\nfile1" } },
    ]);
    assert.deepEqual(end.rawOutput, { content: [{ type: "text", text: "total 1\nfile1" }] });

    // All notifications carry the session id.
    for (const u of h.client.updates) {
      assert.equal(u.sessionId, ns.sessionId);
    }
  } finally {
    await h.close();
  }
});

test("session/prompt (with-tool): read tool maps to kind read with locations", async () => {
  const fake = new FakePi({
    promptBehavior: "with-tool",
    tool: {
      toolCallId: "tc-r",
      toolName: "read",
      args: { path: "/tmp/a.txt" },
      resultText: "hello",
    },
  });
  const h = makeAcpHarness({ fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "read the file" }],
    });

    const [start] = TOOL_EVENTS(h.client.updates.map((u) => u.update));
    assert.equal(start.kind, "read");
    assert.equal(start.title, "read: /tmp/a.txt");
    assert.deepEqual(start.locations, [{ path: "/tmp/a.txt" }]);
    assert.deepEqual(start.rawInput, { path: "/tmp/a.txt" });
  } finally {
    await h.close();
  }
});

test("session/prompt (with-tool, isError): tool_call_update status failed", async () => {
  const fake = new FakePi({
    promptBehavior: "with-tool",
    tool: {
      toolCallId: "tc-2",
      toolName: "bash",
      args: { command: "false" },
      resultText: "exit status 1",
      isError: true,
    },
  });
  const h = makeAcpHarness({ fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "fail on purpose" }],
    });
    assert.equal(res.stopReason, "end_turn");

    await waitFor(() =>
      TOOL_EVENTS(h.client.updates.map((u) => u.update)).some((e) => e.status === "failed"),
    );
    const [, , end] = TOOL_EVENTS(h.client.updates.map((u) => u.update));
    assert.equal(end.toolCallId, "tc-2");
    assert.equal(end.status, "failed", "isError tool must end as failed");
    assert.deepEqual(end.rawOutput, { content: [{ type: "text", text: "exit status 1" }] });
  } finally {
    await h.close();
  }
});

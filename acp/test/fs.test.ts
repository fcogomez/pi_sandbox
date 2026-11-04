import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_INIT_PARAMS,
  FakeAcpClient,
  makeAcpHarness,
  waitFor,
} from "./fake-acp-client.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * fs/read_text_file delegation tests (ticket ACP-A2, tests 5-6).
 *
 * The fake pi simulates the bundled read-tool override: it emits
 * tool_execution_start (read) and then an extension_ui_request (input,
 * `[acp:read] <path>`), waiting for the adapter's extension_ui_response.
 * offset/limit application happens inside the extension (not the adapter);
 * the adapter's job — verified here — is to send the correct path to
 * readTextFile and write the content back (or cancel).
 * NO real pi, NO LLM, NO vLLM, NO network.
 */

const toolCallUpdates = (u: SessionUpdate[]): ToolCallUpdate[] =>
  u.filter((x) => x.sessionUpdate === "tool_call_update") as ToolCallUpdate[];

test("fs/read_text_file delegation: client content is written back to pi", async () => {
  const fake = new FakePi({
    promptBehavior: "with-read",
    fsDelegation: true,
    readPath: "/tmp/delegated.txt",
  });
  const client = new FakeAcpClient({
    respondReadTextFile: () => ({ content: "line1\nline2\nline3" }),
  });
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS); // advertises fs.readTextFile
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "read /tmp/delegated.txt" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // The client received read_text_file for the correct session + path.
    assert.equal(client.readTextFileRequests.length, 1);
    assert.equal(client.readTextFileRequests[0].sessionId, ns.sessionId);
    assert.equal(client.readTextFileRequests[0].path, "/tmp/delegated.txt");

    // The adapter wrote the full content back to pi (the extension applies
    // offset/limit locally after receiving it).
    assert.deepEqual(
      fake.uiResponses.map((r) => r.value),
      ["line1\nline2\nline3"],
    );

    // The tool completed with the delegated content.
    await waitFor(() =>
      toolCallUpdates(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const end = toolCallUpdates(h.client.updates.map((u) => u.update)).at(-1)!;
    assert.equal(end.status, "completed");
    assert.deepEqual(end.content, [
      { type: "content", content: { type: "text", text: "line1\nline2\nline3" } },
    ]);

    // Read-only tools never trigger a permission request.
    assert.equal(client.permissionRequests.length, 0);
  } finally {
    await h.close();
  }
});

test("fs/read_text_file fallback: client without capability -> cancelled response", async () => {
  const fake = new FakePi({
    promptBehavior: "with-read",
    fsDelegation: true,
    readPath: "/tmp/delegated.txt",
    readFallbackText: "local fallback content",
  });
  const client = new FakeAcpClient({
    respondReadTextFile: () => {
      throw new Error("readTextFile not supported by this client");
    },
  });
  // Client does NOT advertise fs.readTextFile.
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize({
      ...DEFAULT_INIT_PARAMS,
      clientCapabilities: {},
    });
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "read /tmp/delegated.txt" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // The capability check short-circuits: the client is never called.
    assert.equal(client.readTextFileRequests.length, 0);

    // The adapter wrote cancelled back to pi so the extension falls back
    // to a local read (simulated by the fake).
    assert.equal(fake.uiResponses.length, 1);
    assert.equal(fake.uiResponses[0].cancelled, true);
    assert.equal(fake.uiResponses[0].value, undefined);

    // The tool still completes, with the simulated local fallback content.
    await waitFor(() =>
      toolCallUpdates(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const end = toolCallUpdates(h.client.updates.map((u) => u.update)).at(-1)!;
    assert.equal(end.status, "completed");
    assert.deepEqual(end.content, [
      { type: "content", content: { type: "text", text: "local fallback content" } },
    ]);
  } finally {
    await h.close();
  }
});

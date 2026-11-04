import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  DEFAULT_INIT_PARAMS,
  FakeAcpClient,
  makeAcpHarness,
  waitFor,
} from "./fake-acp-client.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * Permission round-trip tests (ticket ACP-A2, tests 3-4).
 *
 * The fake pi simulates the bundled extension's gated `tool_call` handler:
 * it emits an `extension_ui_request` (select, `[acp:perm] ...`) BEFORE
 * tool_execution_start and blocks until the adapter writes back the
 * selected option. NO real pi, NO LLM, NO vLLM, NO network.
 */

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

const TOOL_EVENTS = (u: SessionUpdate[]): ToolUpdate[] =>
  u.filter(
    (x) => x.sessionUpdate === "tool_call" || x.sessionUpdate === "tool_call_update",
  ) as unknown as ToolUpdate[];

test("permission granted: allow_once -> extension_ui_response -> tool runs to completion", async () => {
  const fake = new FakePi({
    promptBehavior: "with-permission",
    tool: {
      toolCallId: "tc-p1",
      toolName: "bash",
      args: { command: "rm -rf /tmp/x" },
      resultText: "removed",
    },
  });
  const client = new FakeAcpClient({
    respondPermission: () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }),
  });
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "clean up" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // The client was asked exactly once, with the locked 2 options.
    assert.equal(client.permissionRequests.length, 1);
    const perm = client.permissionRequests[0];
    assert.equal(perm.sessionId, ns.sessionId);
    assert.equal(perm.toolCall.toolCallId, "tc-p1");
    assert.equal(perm.toolCall.kind, "execute");
    assert.equal(perm.toolCall.status, "pending");
    assert.deepEqual(perm.options, [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ]);

    // The adapter wrote the selected option back to pi.
    assert.deepEqual(
      fake.uiResponses.map((r) => r.value),
      ["allow_once"],
      "adapter must echo allow_once to pi",
    );

    // A pending tool_call was emitted, then pi continued: in_progress -> completed.
    await waitFor(() =>
      TOOL_EVENTS(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const events = TOOL_EVENTS(h.client.updates.map((u) => u.update));
    const start = events.find((e) => e.status === "pending");
    assert.ok(start, "a pending tool_call must be emitted before the request");
    assert.equal(start!.toolCallId, "tc-p1");
    assert.equal(start!.kind, "execute");
    assert.ok(events.some((e) => e.sessionUpdate === "tool_call" && e.status === "in_progress"));
    const end = events.find((e) => e.status === "completed");
    assert.ok(end, "the granted tool must complete");
    assert.equal(end!.toolCallId, "tc-p1");
  } finally {
    await h.close();
  }
});

test("permission denied: reject_once -> extension_ui_response -> tool ends failed", async () => {
  const fake = new FakePi({
    promptBehavior: "with-permission",
    tool: {
      toolCallId: "tc-p2",
      toolName: "write",
      args: { path: "/tmp/x", content: "no" },
      resultText: "User denied",
    },
  });
  const client = new FakeAcpClient({
    respondPermission: () => ({
      outcome: { outcome: "selected", optionId: "reject_once" },
    }),
  });
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "write a file" }],
    });
    assert.equal(res.stopReason, "end_turn");

    assert.equal(client.permissionRequests.length, 1);
    assert.equal(client.permissionRequests[0].toolCall.kind, "edit", "write maps to edit");

    // The adapter wrote the rejection back to pi.
    assert.deepEqual(
      fake.uiResponses.map((r) => r.value),
      ["reject_once"],
      "adapter must echo reject_once to pi",
    );

    // pi reported the blocked tool as an error -> ACP status failed.
    await waitFor(() =>
      TOOL_EVENTS(h.client.updates.map((u) => u.update)).some((e) => e.status === "failed"),
    );
    const events = TOOL_EVENTS(h.client.updates.map((u) => u.update));
    const start = events.find((e) => e.status === "pending");
    assert.ok(start, "a pending tool_call must be emitted before the request");
    assert.equal(start!.toolCallId, "tc-p2");
    const end = events.find((e) => e.status === "failed");
    assert.ok(end, "denied tool must end as failed");
    assert.equal(end!.toolCallId, "tc-p2");
    assert.deepEqual(end!.content, [
      { type: "content", content: { type: "text", text: "User denied" } },
    ]);
  } finally {
    await h.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  DEFAULT_GATED_TOOLS,
  DEFAULT_UNGATED_TOOLS,
  isGatedTool,
} from "../src/config.js";
import {
  DEFAULT_INIT_PARAMS,
  FakeAcpClient,
  makeAcpHarness,
  waitFor,
} from "./fake-acp-client.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * M2.1: ACP permission gating for Xcode MCP tools.
 *
 * Unit: the pure `isGatedTool` helper (exact names, `prefix*` patterns,
 * ungated override). E2E: gated MCP tools get a `session/request_permission`
 * round-trip (allow continues, deny cancels — same shape as the bash/write
 * gating tests); ungated (read-only) MCP tools complete with NO permission
 * request. Fake in-process pi only: NO real pi, NO LLM, NO vLLM, NO network.
 */

// ---------------------------------------------------------------------
// Unit: isGatedTool
// ---------------------------------------------------------------------

const BWE = ["bash", "write", "edit"];
const MCP_STAR = ["mcp__xcode_tools__*"];
const DOC_SEARCH = ["mcp__xcode_tools__DocumentationSearch"];

test("isGatedTool: exact match", () => {
  assert.equal(isGatedTool("bash", BWE), true);
  assert.equal(isGatedTool("write", BWE), true);
  assert.equal(isGatedTool("edit", BWE), true);
  // Exact patterns do not prefix-match.
  assert.equal(isGatedTool("bashrc", BWE), false);
});

test("isGatedTool: prefix* match", () => {
  assert.equal(isGatedTool("mcp__xcode_tools__BuildProject", MCP_STAR), true);
  assert.equal(isGatedTool("mcp__xcode_tools__DocumentationSearch", MCP_STAR), true);
  // Other MCP servers are not matched by the xcode prefix.
  assert.equal(isGatedTool("mcp__other__Build", MCP_STAR), false);
});

test("isGatedTool: ungated override (gated pattern + ungated exact -> NOT gated)", () => {
  assert.equal(
    isGatedTool("mcp__xcode_tools__DocumentationSearch", [...BWE, ...MCP_STAR], DOC_SEARCH),
    false,
  );
  // A gated tool not in the ungated list stays gated.
  assert.equal(
    isGatedTool("mcp__xcode_tools__BuildProject", [...BWE, ...MCP_STAR], DOC_SEARCH),
    true,
  );
  // Ungated patterns also support prefix matching.
  assert.equal(
    isGatedTool("mcp__xcode_tools__GetBuildLog", [...BWE, ...MCP_STAR], ["mcp__xcode_tools__Get*"]),
    false,
  );
});

test("isGatedTool: no match -> not gated", () => {
  assert.equal(isGatedTool("read", BWE), false);
  assert.equal(isGatedTool("mcp__xcode_tools__DocumentationSearch", BWE), false);
  assert.equal(isGatedTool("mcp__xcode_tools__DocumentationSearch", []), false);
});

test("isGatedTool: empty patterns", () => {
  assert.equal(isGatedTool("bash", []), false);
  assert.equal(isGatedTool("bash", [], DOC_SEARCH), false);
  assert.equal(isGatedTool("", BWE), false);
  assert.equal(isGatedTool("write", ["", "write"]), true, "empty entries are inert");
});

test("default lists: xcode catch-all gated, read-only set carved out", () => {
  assert.ok(DEFAULT_GATED_TOOLS.includes("mcp__xcode_tools__*"));
  assert.deepEqual(DEFAULT_GATED_TOOLS, "bash,write,edit,mcp__xcode_tools__*".split(","));
  for (const name of DEFAULT_UNGATED_TOOLS) {
    assert.ok(
      isGatedTool(name, DEFAULT_GATED_TOOLS) &&
        !isGatedTool(name, DEFAULT_GATED_TOOLS, DEFAULT_UNGATED_TOOLS),
      `${name} must be gated by the catch-all and carved out by the ungated list`,
    );
  }
  assert.equal(isGatedTool("mcp__xcode_tools__BuildProject", DEFAULT_GATED_TOOLS, DEFAULT_UNGATED_TOOLS), true);
  // Existing non-xcode behavior is unchanged.
  for (const name of ["bash", "write", "edit"]) {
    assert.equal(isGatedTool(name, DEFAULT_GATED_TOOLS, DEFAULT_UNGATED_TOOLS), true);
  }
  for (const name of ["read", "grep", "ls", "find"]) {
    assert.equal(isGatedTool(name, DEFAULT_GATED_TOOLS, DEFAULT_UNGATED_TOOLS), false);
  }
});

// ---------------------------------------------------------------------
// E2E: MCP tool gating through the ACP adapter (fake pi + fake client)
// ---------------------------------------------------------------------

interface ToolUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  kind?: string;
  status?: string;
  title?: string;
  content?: Array<{ type: string; content: unknown }>;
}

const TOOL_EVENTS = (u: SessionUpdate[]): ToolUpdate[] =>
  u.filter(
    (x) => x.sessionUpdate === "tool_call" || x.sessionUpdate === "tool_call_update",
  ) as unknown as ToolUpdate[];

test("gated MCP tool allowed: mcp__xcode_tools__BuildProject -> request_permission -> allow_once -> completes", async () => {
  const fake = new FakePi({
    promptBehavior: "with-permission",
    tool: {
      toolCallId: "tc-mcp-1",
      toolName: "mcp__xcode_tools__BuildProject",
      args: { scheme: "Demo" },
      partialText: "building…",
      resultText: "Build succeeded",
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
      prompt: [{ type: "text", text: "build the project" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // The client was asked exactly once, with the locked 2 options.
    assert.equal(client.permissionRequests.length, 1);
    const perm = client.permissionRequests[0];
    assert.equal(perm.sessionId, ns.sessionId);
    assert.equal(perm.toolCall.toolCallId, "tc-mcp-1");
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
    assert.equal(start!.toolCallId, "tc-mcp-1");
    assert.ok(events.some((e) => e.sessionUpdate === "tool_call" && e.status === "in_progress"));
    const end = events.find((e) => e.status === "completed");
    assert.ok(end, "the granted MCP tool must complete");
    assert.equal(end!.toolCallId, "tc-mcp-1");
  } finally {
    await h.close();
  }
});

test("gated MCP tool denied: mcp__xcode_tools__BuildProject -> request_permission -> reject_once -> cancelled (failed)", async () => {
  const fake = new FakePi({
    promptBehavior: "with-permission",
    tool: {
      toolCallId: "tc-mcp-2",
      toolName: "mcp__xcode_tools__BuildProject",
      args: { scheme: "Demo" },
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
      prompt: [{ type: "text", text: "build the project" }],
    });
    assert.equal(res.stopReason, "end_turn");

    assert.equal(client.permissionRequests.length, 1);
    assert.equal(client.permissionRequests[0].toolCall.toolCallId, "tc-mcp-2");

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
    assert.equal(start!.toolCallId, "tc-mcp-2");
    const end = events.find((e) => e.status === "failed");
    assert.ok(end, "denied MCP tool must end as failed");
    assert.equal(end!.toolCallId, "tc-mcp-2");
    assert.deepEqual(end!.content, [
      { type: "content", content: { type: "text", text: "User denied" } },
    ]);
  } finally {
    await h.close();
  }
});

test("ungated MCP tool: mcp__xcode_tools__DocumentationSearch -> NO request_permission, completes", async () => {
  const fake = new FakePi({
    promptBehavior: "with-permission",
    tool: {
      toolCallId: "tc-mcp-3",
      toolName: "mcp__xcode_tools__DocumentationSearch",
      args: { query: "UIView" },
      resultText: "found 3 docs",
    },
  });
  const client = new FakeAcpClient();
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "search the docs" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // No permission round-trip at all for the read-only tool.
    assert.equal(client.permissionRequests.length, 0);
    assert.equal(fake.uiResponses.length, 0);

    // The tool ran straight through: in_progress -> completed.
    await waitFor(() =>
      TOOL_EVENTS(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const events = TOOL_EVENTS(h.client.updates.map((u) => u.update));
    assert.equal(events.length, 3, "start/update/end, no pending step");
    assert.equal(events[0].sessionUpdate, "tool_call");
    assert.equal(events[0].toolCallId, "tc-mcp-3");
    assert.equal(events[0].status, "in_progress");
    assert.equal(events[2].status, "completed");
  } finally {
    await h.close();
  }
});

test("adapter spawns pi with ACP_GATED_TOOLS + ACP_UNGATED_TOOLS env (default config)", async () => {
  const fake = new FakePi();
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const h = makeAcpHarness({
    fake,
    spawner: (_c, _a, options) => {
      capturedEnv = options.env;
      return fake;
    },
  });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    assert.ok(capturedEnv, "spawner must receive the child env");
    assert.equal(capturedEnv!.ACP_GATED_TOOLS, DEFAULT_GATED_TOOLS.join(","));
    assert.equal(capturedEnv!.ACP_UNGATED_TOOLS, DEFAULT_UNGATED_TOOLS.join(","));
    assert.ok(
      capturedEnv!.ACP_GATED_TOOLS!.split(",").includes("mcp__xcode_tools__*"),
      "default gated list must carry the xcode catch-all",
    );
    assert.ok(
      capturedEnv!.ACP_UNGATED_TOOLS!.split(",").includes(
        "mcp__xcode_tools__DocumentationSearch",
      ),
      "default ungated list must carve out the read-only tools",
    );
  } finally {
    await h.close();
  }
});

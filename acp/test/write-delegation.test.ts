import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type {
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_INIT_PARAMS_WITH_WRITE,
  FakeAcpClient,
  makeAcpHarness,
  waitFor,
} from "./fake-acp-client.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * fs/write_text_file delegation tests (ticket ACP-C3).
 *
 * The fake pi simulates the bundled write-tool override: it emits
 * tool_execution_start (write, {path, content}) and then an
 * extension_ui_request (input, `[acp:write] <toolCallId> <path>`), waiting
 * for the adapter's extension_ui_response. The adapter's job — verified
 * here — is to call writeTextFile with the STORED args (path from the
 * title, content from the tool args) and write "ok" back (or cancel for a
 * local fallback). NO real pi, NO LLM, NO vLLM, NO network.
 */

const toolCallUpdates = (u: SessionUpdate[]): ToolCallUpdate[] =>
  u.filter((x) => x.sessionUpdate === "tool_call_update") as ToolCallUpdate[];

const stamp = Date.now();

test("fs/write_text_file delegation: client receives exact {path, content}", async () => {
  const path = `/tmp/acp-c3-test-${stamp}-ok.txt`;
  const content = "hello acp c3 write\n";
  const fake = new FakePi({
    promptBehavior: "with-write",
    fsDelegation: true,
    writePath: path,
    writeContent: content,
  });
  const client = new FakeAcpClient();
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS_WITH_WRITE); // advertises fs.writeTextFile
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "write the file" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // The client received exactly ONE write_text_file with the exact args
    // (content comes from the stored tool args, never the dialog title).
    assert.equal(client.writeTextFileRequests.length, 1);
    assert.deepEqual(client.writeTextFileRequests[0], {
      sessionId: ns.sessionId,
      path,
      content,
    });

    // The adapter wrote "ok" back to pi (the extension's success signal).
    assert.deepEqual(fake.uiResponses.map((r) => r.value), ["ok"]);

    // The tool completed with the synthetic delegated-write result and
    // NOTHING was written to the local container path.
    await waitFor(() =>
      toolCallUpdates(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const end = toolCallUpdates(h.client.updates.map((u) => u.update)).at(-1)!;
    assert.equal(end.status, "completed");
    assert.deepEqual(end.content, [
      {
        type: "content",
        content: { type: "text", text: `Wrote ${content.length} chars to ${path} via client` },
      },
    ]);
    assert.equal(existsSync(path), false);
  } finally {
    await h.close();
    if (existsSync(path)) unlinkSync(path);
  }
});

test("fs/write_text_file fallback: client without capability -> local write", async () => {
  const path = `/tmp/acp-c3-test-${stamp}-off.txt`;
  const content = "local fallback write\n";
  const fake = new FakePi({
    promptBehavior: "with-write",
    fsDelegation: true,
    writePath: path,
    writeContent: content,
  });
  const client = new FakeAcpClient();
  // Client does NOT advertise fs.writeTextFile.
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize({
      ...DEFAULT_INIT_PARAMS_WITH_WRITE,
      clientCapabilities: {},
    });
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "write the file" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // The capability check short-circuits: the client is never called.
    assert.equal(client.writeTextFileRequests.length, 0);

    // The adapter wrote cancelled back to pi so the extension falls back
    // to a local write (the fake performs the real write at the tmp path).
    assert.equal(fake.uiResponses.length, 1);
    assert.equal(fake.uiResponses[0].cancelled, true);
    assert.equal(fake.uiResponses[0].value, undefined);

    // The tool still completes, with the local-fallback result — and the
    // local file actually landed in the container.
    await waitFor(() =>
      toolCallUpdates(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const end = toolCallUpdates(h.client.updates.map((u) => u.update)).at(-1)!;
    assert.equal(end.status, "completed");
    assert.deepEqual(end.content, [
      {
        type: "content",
        content: { type: "text", text: `Wrote ${content.length} chars to ${path}` },
      },
    ]);
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(path, "utf-8"), content);
  } finally {
    await h.close();
    if (existsSync(path)) unlinkSync(path);
  }
});

test("fs/write_text_file mismatch: title path != stored args path -> cancelled", async () => {
  const realPath = `/tmp/acp-c3-test-${stamp}-mismatch-real.txt`;
  const titlePath = `/tmp/acp-c3-test-${stamp}-mismatch-title.txt`;
  const content = "mismatch write\n";
  const fake = new FakePi({
    promptBehavior: "with-write",
    fsDelegation: true,
    writePath: realPath,
    writeTitlePath: titlePath, // title disagrees with the tool args
    writeContent: content,
  });
  const client = new FakeAcpClient();
  const h = makeAcpHarness({ client, fake });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS_WITH_WRITE);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    const res = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "write the file" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // Mismatch guard: the client is never called and the dialog is
    // cancelled so the extension falls back to a local write.
    assert.equal(client.writeTextFileRequests.length, 0);
    assert.equal(fake.uiResponses.length, 1);
    assert.equal(fake.uiResponses[0].cancelled, true);
    assert.equal(fake.uiResponses[0].value, undefined);

    // The local fallback write landed at the REAL (args) path, not the
    // (wrong) title path.
    await waitFor(() =>
      toolCallUpdates(h.client.updates.map((u) => u.update)).some((e) => e.status === "completed"),
    );
    const end = toolCallUpdates(h.client.updates.map((u) => u.update)).at(-1)!;
    assert.equal(end.status, "completed");
    assert.equal(existsSync(realPath), true);
    assert.equal(readFileSync(realPath, "utf-8"), content);
    assert.equal(existsSync(titlePath), false);
  } finally {
    await h.close();
    for (const p of [realPath, titlePath]) if (existsSync(p)) unlinkSync(p);
  }
});

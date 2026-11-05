import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RequestError,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_INIT_PARAMS,
  FakeAcpClient,
  makeAcpHarness,
  waitFor,
} from "./fake-acp-client.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * Unit tests for session persistence (ticket ACP-A3).
 *
 * Fake pi (per-sessionFile message store, switch_session/abort/get_state/
 * get_messages) + fake ACP client over the real SDK stream framing. NO real
 * pi, NO LLM, NO network — fully offline. Session-map files live in
 * fs.mkdtemp directories and are cleaned up.
 */

/** Extract the text of a content-chunk session update ("" for others). */
function chunkText(u: SessionUpdate): string {
  const c = (u as { content?: { type?: unknown; text?: unknown } }).content;
  return c && c.type === "text" && typeof c.text === "string" ? c.text : "";
}

/** Texts of all user_message_chunk updates among the given updates. */
function userTexts(updates: SessionNotification[]): string[] {
  return updates
    .map((n) => n.update)
    .filter((u) => u.sessionUpdate === "user_message_chunk")
    .map(chunkText);
}

/** Texts of all agent_message_chunk updates among the given updates. */
function agentTexts(updates: SessionNotification[]): string[] {
  return updates
    .map((n) => n.update)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map(chunkText);
}

async function tempDir(prefix: string): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("A3.1 load after cancel: abort observed, switch_session, replay, context continues", async () => {
  // The fake pi's session file must exist on disk (the adapter verifies it
  // before spawning pi).
  await mkdir("/tmp/fake", { recursive: true });
  await writeFile("/tmp/fake/s1.jsonl", "");
  const { dir: mapDir, cleanup } = await tempDir("acp-a3-cancel-");
  const mapPath = join(mapDir, "sessions.json");

  // Deterministic "prompt in flight": the 2nd prompt's permission dialog is
  // held open until the test has sent session/cancel.
  let gateResolve: () => void = () => undefined;
  const gate = new Promise<void>((r) => (gateResolve = r));
  let permCalls = 0;
  const client = new FakeAcpClient({
    respondPermission: async () => {
      permCalls += 1;
      if (permCalls === 2) await gate;
      return {
        outcome: {
          outcome: "selected",
          optionId: permCalls === 2 ? "reject_once" : "allow_once",
        },
      };
    },
  });

  const fake = new FakePi({
    sessionFile: "/tmp/fake/s1.jsonl",
    promptBehavior: "with-permission",
    tool: { toolCallId: "tc-1", toolName: "bash", args: { command: "ls -la" } },
    textDeltas: ["Hello", " there"],
    thinkingDeltas: ["Thinking…"],
  });
  const h = makeAcpHarness({
    fake,
    client,
    config: { thinkingLevel: "medium", sessionMapPath: mapPath },
  });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });

    // First prompt completes (permission allowed).
    const first = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    assert.equal(first.stopReason, "end_turn");

    // session/new persisted the map entry (pi's sessionFile + own id).
    const rawMap = JSON.parse(await readFile(mapPath, "utf8")) as Record<
      string,
      { piSessionId: string; sessionFile: string; cwd: string; thinkingLevel: string }
    >;
    assert.equal(rawMap[ns.sessionId].sessionFile, "/tmp/fake/s1.jsonl");
    assert.ok(rawMap[ns.sessionId].piSessionId.length > 0);
    assert.equal(rawMap[ns.sessionId].cwd, "/tmp/work");
    assert.equal(rawMap[ns.sessionId].thinkingLevel, "medium");

    // Second prompt in flight, blocked at the permission dialog.
    const second = h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "run it" }],
    });
    await waitFor(() => client.permissionRequests.length === 2);

    // Cancel while the prompt is in flight.
    await h.conn.cancel({ sessionId: ns.sessionId });
    const res = await second;
    assert.equal(res.stopReason, "cancelled", "in-flight prompt must report stopReason 'cancelled'");
    assert.equal(fake.commandsOf("abort").length, 1, "fake pi must have received abort");
    gateResolve(); // unblock the (now moot) permission dialog

    // Load the session with the SAME ACP sessionId.
    const updatesBeforeLoad = h.client.updates.length;
    const loadRes = await h.conn.loadSession({
      sessionId: ns.sessionId,
      cwd: "/tmp/work",
      mcpServers: [],
    });
    assert.equal(loadRes.modes, null);
    const opt = loadRes.configOptions?.find((o) => o.id === "thinking_level");
    assert.ok(opt, "load response must report the thinking_level config option");

    // The (re)spawned pi switched to the persisted session file.
    const switches = fake.commandsOf("switch_session");
    assert.equal(switches.length, 1, "fake pi must have received exactly one switch_session");
    assert.equal(switches[0].sessionPath, "/tmp/fake/s1.jsonl");

    // The replayed history arrived as session updates BEFORE the load
    // response: everything after the snapshot is replay (no prompts ran
    // on agent side in between).
    const replay = h.client.updates.slice(updatesBeforeLoad);
    assert.deepEqual(userTexts(replay), ["hello", "run it"]);
    assert.equal(agentTexts(replay).join(""), "Hello there");
    assert.ok(
      replay.some((n) => n.update.sessionUpdate === "agent_thought_chunk"),
      "replayed assistant thinking must be replayed as agent_thought_chunk",
    );
    const toolCalls = replay
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate === "tool_call");
    assert.equal(toolCalls.length, 1, "replayed toolCall block must produce one tool_call update");
    const tc = toolCalls[0] as {
      toolCallId: string;
      title: string;
      kind: string;
      status: string;
      rawInput: unknown;
    };
    assert.equal(tc.toolCallId, "tc-1");
    assert.ok(tc.title.startsWith("bash: "), "title is '<toolName>: <args JSON>'");
    assert.equal(tc.kind, "execute", "kind reuses the locked A2 mapping");
    assert.equal(tc.status, "completed");
    assert.deepEqual(tc.rawInput, { command: "ls -la" });
    for (const n of replay) assert.equal(n.sessionId, ns.sessionId);

    // A subsequent prompt continues with the prior context: the history in
    // the session file keeps growing (u,a | u | u,a = 5 messages).
    const third = await h.conn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "again" }],
    });
    assert.equal(third.stopReason, "end_turn");
    const state = await h.agent.getSessionState(ns.sessionId);
    assert.equal(state.messageCount, 5, "history must continue from the loaded context");
  } finally {
    gateResolve();
    await h.close();
    await cleanup();
  }
});

test("A3.2 restart: loadSession replays from the persisted map, resumeSession does not", async () => {
  const { dir, cleanup } = await tempDir("acp-a3-restart-");
  const mapPath = join(dir, "sessions.json");
  const sessionFile = join(dir, "s1.jsonl");
  await writeFile(sessionFile, "");

  // --- Agent instance #1: create the session, run one prompt. ---
  const fake1 = new FakePi({ sessionFile, textDeltas: ["One", " world"] });
  const h1 = makeAcpHarness({
    fake: fake1,
    config: { thinkingLevel: "high", sessionMapPath: mapPath },
  });
  await h1.conn.initialize(DEFAULT_INIT_PARAMS);
  const ns = await h1.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
  const p1 = await h1.conn.prompt({
    sessionId: ns.sessionId,
    prompt: [{ type: "text", text: "remember this" }],
  });
  assert.equal(p1.stopReason, "end_turn");

  const rawMap = JSON.parse(await readFile(mapPath, "utf8")) as Record<
    string,
    { sessionFile: string; thinkingLevel: string }
  >;
  assert.equal(rawMap[ns.sessionId].sessionFile, sessionFile);
  assert.equal(rawMap[ns.sessionId].thinkingLevel, "high");

  // Simulated adapter restart: shutdown kills fake pi #1; the map + the
  // per-sessionFile store survive.
  h1.agent.shutdown();

  // --- Agent instance #2 (same map path): loadSession. ---
  const fake2 = new FakePi({ sessionFile, textDeltas: ["Two", " world"] });
  const h2 = makeAcpHarness({
    fake: fake2,
    config: { thinkingLevel: "high", sessionMapPath: mapPath },
  });
  await h2.conn.initialize(DEFAULT_INIT_PARAMS);
  const loadRes = await h2.conn.loadSession({
    sessionId: ns.sessionId,
    cwd: "/tmp/work",
    mcpServers: [],
  });
  assert.equal(loadRes.modes, null);

  const sw2 = fake2.commandsOf("switch_session");
  assert.equal(sw2.length, 1, "fake pi #2 must have received exactly one switch_session");
  assert.equal(sw2[0].sessionPath, sessionFile, "must switch to the persisted sessionFile");

  // loadSession replays the history (all updates on agent #2 are replay).
  assert.deepEqual(userTexts(h2.client.updates), ["remember this"]);
  assert.equal(agentTexts(h2.client.updates).join(""), "One world");

  // The persisted thinking level (high) is re-applied on the fresh pi.
  assert.deepEqual(
    fake2.commandsOf("set_thinking_level").map((c) => c.level),
    ["high"],
  );

  // A prompt on agent #2 works and appends to the same history.
  const p2 = await h2.conn.prompt({
    sessionId: ns.sessionId,
    prompt: [{ type: "text", text: "what was it?" }],
  });
  assert.equal(p2.stopReason, "end_turn");
  await h2.close();

  // --- Agent instance #3 (same map path): resumeSession — NO replay. ---
  const fake3 = new FakePi({ sessionFile, textDeltas: ["Three", " world"] });
  const h3 = makeAcpHarness({
    fake: fake3,
    config: { thinkingLevel: "high", sessionMapPath: mapPath },
  });
  await h3.conn.initialize(DEFAULT_INIT_PARAMS);
  const resumeRes = await h3.conn.resumeSession({
    sessionId: ns.sessionId,
    cwd: "/tmp/work",
  });
  assert.equal(resumeRes.modes, null);
  assert.equal(h3.client.updates.length, 0, "resumeSession must replay ZERO updates");
  assert.equal(fake3.commandsOf("switch_session").length, 1);
  const p3 = await h3.conn.prompt({
    sessionId: ns.sessionId,
    prompt: [{ type: "text", text: "again" }],
  });
  assert.equal(p3.stopReason, "end_turn");
  await h3.close();

  await cleanup();
});

test("A3.3 cancel of an unknown session resolves cleanly (no throw, no pi, no map mutation)", async () => {
  const { dir, cleanup } = await tempDir("acp-a3-cancel-unknown-");
  const mapPath = join(dir, "sessions.json");
  const h = makeAcpHarness({
    config: { thinkingLevel: "medium", sessionMapPath: mapPath },
  });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);

    // session/cancel is a notification: unknown session must NOT throw.
    await h.conn.cancel({ sessionId: "pi-doesnotexist" });

    assert.equal(h.fake.commands.length, 0, "no pi process must be spawned");

    // No map mutation: the map file was never written with an entry.
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(await readFile(mapPath, "utf8")) as Record<string, unknown>;
    } catch {
      raw = null; // map never written — fine
    }
    assert.ok(
      !raw || !("pi-doesnotexist" in raw),
      "cancel of an unknown session must not touch the map",
    );

    // The adapter is still fully functional.
    const ns = await h.conn.newSession({ cwd: "/tmp/work", mcpServers: [] });
    assert.ok(typeof ns.sessionId === "string" && ns.sessionId.length > 0);
  } finally {
    await h.close();
    await cleanup();
  }
});

test("A3.4 load of an unknown session -> clean invalidParams; capabilities advertised", async () => {
  const { dir, cleanup } = await tempDir("acp-a3-load-unknown-");
  const mapPath = join(dir, "sessions.json");
  const h = makeAcpHarness({
    config: { thinkingLevel: "medium", sessionMapPath: mapPath },
  });
  try {
    const initRes = await h.conn.initialize(DEFAULT_INIT_PARAMS);
    // initialize advertises EXACTLY the A3 persistence capabilities
    // (locked A3 decision #6).
    assert.ok(initRes.agentCapabilities, "agentCapabilities must be present");
    assert.equal(initRes.agentCapabilities.loadSession, true);
    assert.deepEqual(initRes.agentCapabilities.sessionCapabilities, { resume: {} });

    let caught: unknown;
    try {
      await h.conn.loadSession({
        sessionId: "pi-nope",
        cwd: "/tmp/work",
        mcpServers: [],
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof RequestError,
      `expected a RequestError (clean JSON-RPC error), got: ${String(caught)}`,
    );
    assert.equal(
      caught.code,
      RequestError.invalidParams().code,
      "must be an invalidParams error",
    );
    assert.equal(h.fake.commands.length, 0, "no pi process must be spawned");
  } finally {
    await h.close();
    await cleanup();
  }
});

test("A3.5 load with a stale map entry -> clean error, entry removed, no pi spawned", async () => {
  const { dir, cleanup } = await tempDir("acp-a3-stale-");
  const mapPath = join(dir, "sessions.json");
  // A persisted entry whose sessionFile no longer exists on disk.
  const stale = {
    "pi-stale": {
      piSessionId: "fake-pi-session-1",
      sessionFile: join(dir, "missing.jsonl"), // never created
      cwd: "/tmp/work",
      thinkingLevel: "medium",
      createdAt: new Date(0).toISOString(),
      lastUsedAt: new Date(0).toISOString(),
    },
  };
  await writeFile(mapPath, JSON.stringify(stale, null, 2));

  const h = makeAcpHarness({
    config: { thinkingLevel: "medium", sessionMapPath: mapPath },
  });
  try {
    await h.conn.initialize(DEFAULT_INIT_PARAMS);

    let caught: unknown;
    try {
      await h.conn.loadSession({
        sessionId: "pi-stale",
        cwd: "/tmp/work",
        mcpServers: [],
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof RequestError,
      `expected a RequestError, got: ${String(caught)}`,
    );
    assert.equal(
      caught.code,
      RequestError.invalidParams().code,
      "stale entry must fail with a clean invalidParams error",
    );
    assert.equal(h.fake.commands.length, 0, "no pi process may be spawned for a stale entry");

    // The stale entry was removed from the persisted map file.
    const raw = JSON.parse(await readFile(mapPath, "utf8")) as Record<string, unknown>;
    assert.ok(!("pi-stale" in raw), "stale entry must be removed from the map file");
  } finally {
    await h.close();
    await cleanup();
  }
});

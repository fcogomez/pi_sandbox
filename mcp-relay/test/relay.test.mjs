import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";

/**
 * M1.2 relay tests.
 *
 * Fully offline: the relay runs against the fake-mcpbridge.mjs fixture
 * (MCP_RELAY_BRIDGE_CMD), on an EPHEMERAL port bound to 127.0.0.1, with a
 * sandboxed HOME (config + logs live under it). No xcrun, no mcpbridge,
 * no LAN.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE = join(ROOT, "test", "fake-mcpbridge.mjs");
const TMP = mkdtempSync(join(tmpdir(), "mcp-relay-test-"));

after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

let relays = [];

function startRelay({ port, bridgeCmd, debug = false }) {
  const home = mkdtempSync(join(TMP, "home-"));
  const cfgDir = join(home, "Library/Application Support/mcp-relay");
  mkdirSync(cfgDir, { recursive: true });
  const key = "test-" + crypto.randomBytes(16).toString("base64url");
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({ port, bind: "127.0.0.1", key, debug }),
  );
  const child = spawn(process.execPath, [join(ROOT, "relay.mjs")], {
    env: { ...process.env, HOME: home, MCP_RELAY_BRIDGE_CMD: bridgeCmd },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const relay = {
    home,
    key,
    port,
    child,
    stderr: "",
    ready: new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start:\n${relay.stderr}`)), 10000);
      const onErr = (d) => {
        relay.stderr += d.toString();
        if (relay.stderr.includes('"event":"listen"')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stderr.on("data", onErr);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`relay exited early (${code}):\n${relay.stderr}`));
      });
    }),
    stop() {
      relays = relays.filter((r) => r !== relay);
      try { child.kill("SIGTERM"); } catch {}
    },
  };
  relays.push(relay);
  return relay;
}

after(() => {
  for (const r of relays) r.stop();
});

/**
 * Minimal raw WS MCP client: one JSON-RPC record per WS text frame.
 */
function connect(port, key) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const client = {
      ws,
      pending: new Map(),
      nextId: 1,
      closeEvents: [],
      frames: [],
      request(method, params) {
        const id = this.nextId++;
        const p = new Promise((res, rej) => {
          this.pending.set(id, { res, rej });
          setTimeout(() => rej(new Error(`timeout waiting for ${method} (id=${id})`)), 10000).unref();
        });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        return p;
      },
      notify(method, params) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      },
      waitClose(ms = 10000) {
        if (this.closeEvents.length) return Promise.resolve(this.closeEvents[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("timed out waiting for WS close")), ms);
          ws.once("close", (code, reason) => {
            clearTimeout(t);
            res({ code, reason: reason.toString() });
          });
        });
      },
      close() {
        return new Promise((res) => {
          ws.once("close", res);
          ws.close(1000, "done");
        });
      },
    };
    ws.on("unexpected-response", (_req, res) => {
      reject({ statusCode: res.statusCode, isHttpError: true });
    });
    ws.on("error", (err) => {
      if (!client.closedByTest) reject(err);
    });
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      client.frames.push(frame);
      const p = frame.id !== undefined && client.pending.get(frame.id);
      if (p) {
        client.pending.delete(frame.id);
        if (frame.error) p.rej(new Error(`JSON-RPC error: ${JSON.stringify(frame.error)}`));
        else p.res(frame.result);
      }
    });
    ws.on("close", (code, reason) => client.closeEvents.push({ code, reason: reason.toString() }));
    ws.on("open", () => resolve(client));
  });
}

/** MCP handshake: initialize + notifications/initialized. */
async function handshake(client) {
  const init = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "relay-test", version: "0.0.0" },
  });
  client.notify("notifications/initialized");
  return init;
}

function waitUntil(fn, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitUntil timeout"));
      setTimeout(tick, 50).unref();
    };
    tick();
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not ours
  }
}

const fake = (extra = "") => `node ${FAKE}${extra ? " " + extra : ""}`;

// ---------------------------------------------------------------------------
// (a) valid key -> WS round-trip initialize + tools/list
// ---------------------------------------------------------------------------
test("valid key: WS round-trip initialize + tools/list", async () => {
  const port = await freePort();
  const r = startRelay({ port, bridgeCmd: fake() });
  await r.ready;
  const c = await connect(port, r.key);
  const init = await handshake(c);
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(init.serverInfo.name, "fake-xcode");
  const list = await c.request("tools/list", {});
  assert.equal(list.tools.length, 2);
  assert.deepEqual(list.tools.map((t) => t.name), ["EchoTool", "PingTool"]);
  await c.close();
  r.stop();
});

// ---------------------------------------------------------------------------
// (b) wrong key -> HTTP 401 on the upgrade AND no child process spawned
// ---------------------------------------------------------------------------
test("wrong key: HTTP 401 on upgrade and no child spawned", async () => {
  const port = await freePort();
  const pidfile = join(TMP, "b-pidfile");
  const r = startRelay({ port, bridgeCmd: fake(`--pidfile ${pidfile}`) });
  await r.ready;

  let err;
  try {
    await connect(port, "wrong-key-" + crypto.randomBytes(16).toString("base64url"));
    assert.fail("connect with wrong key should have failed");
  } catch (e) {
    err = e;
  }
  assert.ok(err.isHttpError, `expected HTTP error, got ${JSON.stringify(err)}`);
  assert.equal(err.statusCode, 401);

  // Also verify a missing Authorization header is rejected with 401.
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("unexpected-response", (_req, res) => {
      assert.equal(res.statusCode, 401);
      resolve();
    });
    ws.on("open", () => reject(new Error("upgrade should not have succeeded")));
    ws.on("error", () => {});
  });

  // No child process may have been spawned on auth failure.
  await waitUntil(() => existsSync(pidfile), 1500)
    .then(() => assert.fail("bridge child WAS spawned despite 401 auth failures"))
    .catch((e) => assert.match(e.message, /waitUntil timeout/));
  r.stop();
});

// ---------------------------------------------------------------------------
// (c) client disconnect -> child killed (pid gone)
// ---------------------------------------------------------------------------
test("client disconnect: SIGTERM the child (pid gone)", async () => {
  const port = await freePort();
  const pidfile = join(TMP, "c-pidfile");
  const r = startRelay({ port, bridgeCmd: fake(`--pidfile ${pidfile}`) });
  await r.ready;
  const c = await connect(port, r.key);
  await handshake(c);
  const pid = parseInt(readFileSync(pidfile, "utf8").trim().split(/\s+/).pop(), 10);
  assert.ok(pidAlive(pid), "bridge child should be alive during the session");
  await c.close();
  await waitUntil(() => !pidAlive(pid), 5000);
  assert.ok(!pidAlive(pid), "bridge child must be killed when the client disconnects");
  r.stop();
});

// ---------------------------------------------------------------------------
// (d) child exits -> WS close code 4500 + exit code + last stderr line in payload
// ---------------------------------------------------------------------------
test("child exits: WS close 4500 with exit code and last stderr line", async () => {
  const port = await freePort();
  const r = startRelay({ port, bridgeCmd: fake("--die-after 2") });
  await r.ready;
  const c = await connect(port, r.key);
  const init = await handshake(c); // inbound line 1 (initialize) + line 2 (initialized) -> child dies
  assert.equal(init.serverInfo.name, "fake-xcode");
  const { code, reason } = await c.waitClose(10000);
  assert.equal(code, 4500);
  assert.match(reason, /code=1/);
  assert.match(reason, /dying \(die-after 2\)/, "payload must contain the last stderr line");
  r.stop();
});

// ---------------------------------------------------------------------------
// (e) two concurrent connections -> independent children (distinct pids,
//     independent tool results)
// ---------------------------------------------------------------------------
test("two concurrent connections: independent children", async () => {
  const port = await freePort();
  const r = startRelay({ port, bridgeCmd: fake() });
  await r.ready;
  const a = await connect(port, r.key);
  const b = await connect(port, r.key);
  await handshake(a);
  await handshake(b);

  const [ra, rb] = await Promise.all([
    a.request("tools/call", { name: "EchoTool", arguments: { tag: "A" } }),
    b.request("tools/call", { name: "EchoTool", arguments: { tag: "B" } }),
  ]);
  const textA = ra.content[0].text;
  const textB = rb.content[0].text;
  assert.match(textA, /"tag":"A"/);
  assert.match(textB, /"tag":"B"/);
  const pidA = Number(/pid (\d+)/.exec(textA)[1]);
  const pidB = Number(/pid (\d+)/.exec(textB)[1]);
  assert.notEqual(pidA, pidB, "each connection must get its own child process");

  // Independence: a tools/list on one connection must not leak into the other.
  const listA = await a.request("tools/list", {});
  assert.equal(listA.tools.length, 2);
  await a.close();
  await b.close();
  r.stop();
});

// ---------------------------------------------------------------------------
// config: missing file -> guidance + exit 1
// ---------------------------------------------------------------------------
test("missing config: prints guidance and exits 1", async () => {
  const home = mkdtempSync(join(TMP, "home-noconfig-"));
  const child = spawn(process.execPath, [join(ROOT, "relay.mjs")], {
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stderr.on("data", (d) => (out += d.toString()));
  child.stdout.on("data", (d) => (out += d.toString()));
  const code = await new Promise((res) => child.on("exit", res));
  assert.equal(code, 1);
  assert.match(out, /config not found/);
  assert.match(out, /install\.sh/);
});

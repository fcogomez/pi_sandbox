import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import net from "node:net";

/**
 * M1.2 consumer-shim tests.
 *
 * The shim (remote-stdio.mjs) is driven over REAL stdio exactly like an MCP
 * client would drive it, against a real relay.mjs child that bridges to the
 * fake-mcpbridge.mjs fixture — fully offline, ephemeral ports, 127.0.0.1.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIM = join(ROOT, "remote-stdio.mjs");
const FAKE = join(ROOT, "test", "fake-mcpbridge.mjs");
const TMP = mkdtempSync(join(tmpdir(), "mcp-relay-shim-"));

const procs = [];
after(() => {
  for (const p of procs) {
    try { p.kill("SIGKILL"); } catch {}
  }
});

function track(p) {
  procs.push(p);
  return p;
}

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

async function startRelay({ port, bridgeExtra = "" }) {
  const home = mkdtempSync(join(TMP, "home-"));
  const cfgDir = join(home, "Library/Application Support/mcp-relay");
  mkdirSync(cfgDir, { recursive: true });
  const key = "test-" + crypto.randomBytes(16).toString("base64url");
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ port, bind: "127.0.0.1", key, debug: false }));
  const child = track(
    spawn(process.execPath, [join(ROOT, "relay.mjs")], {
      env: {
        ...process.env,
        HOME: home,
        MCP_RELAY_BRIDGE_CMD: `node ${FAKE} ${bridgeExtra}`.trim(),
      },
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  const stderr = { value: "" };
  child.stderr.on("data", (d) => (stderr.value += d.toString()));
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`relay did not start:\n${stderr.value}`)), 10000);
    const onErr = (d) => {
      if (stderr.value.includes('"event":"listen"')) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stderr.on("data", onErr);
    child.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`relay exited early (${code}):\n${stderr.value}`));
    });
  });
  return { child, key, ready };
}

/**
 * Spawn the shim with piped stdio; speaks NDJSON JSON-RPC over stdin/stdout.
 */
function startShim({ port, key, envExtra = {} }) {
  const child = track(
    spawn(process.execPath, [SHIM], {
      env: {
        ...process.env,
        MCP_RELAY_URL: `ws://127.0.0.1:${port}`,
        MCP_RELAY_KEY: key,
        ...envExtra,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const client = {
    child,
    pending: new Map(),
    nextId: 1,
    stdoutBuf: "",
    stderr: "",
    onLine: null,
    request(method, params) {
      const id = this.nextId++;
      const p = new Promise((res, rej) => {
        this.pending.set(id, { res, rej });
        setTimeout(() => rej(new Error(`timeout waiting for ${method} (id=${id})`)), 10000).unref();
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return p;
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    exitCode(ms = 10000) {
      if (this._code !== undefined) return Promise.resolve(this._code);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for shim exit")), ms);
        child.once("exit", (code) => {
          clearTimeout(t);
          this._code = code;
          resolve(code);
        });
      });
    },
  };
  child.stdout.on("data", (d) => {
    client.stdoutBuf += d.toString();
    let nl;
    while ((nl = client.stdoutBuf.indexOf("\n")) >= 0) {
      const line = client.stdoutBuf.slice(0, nl);
      client.stdoutBuf = client.stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (client.onLine) client.onLine(frame);
      const p = frame.id !== undefined && client.pending.get(frame.id);
      if (p) {
        client.pending.delete(frame.id);
        if (frame.error) p.rej(new Error(`JSON-RPC error: ${JSON.stringify(frame.error)}`));
        else p.res(frame.result);
      }
    }
  });
  child.stderr.on("data", (d) => (client.stderr += d.toString()));
  return client;
}

function envWithout(vars) {
  const env = { ...process.env };
  for (const v of vars) delete env[v];
  return env;
}

// ---------------------------------------------------------------------------
// (a) full stdio round-trip: initialize + tools/list + tools/call
// ---------------------------------------------------------------------------
test("shim: full stdio round-trip initialize + tools/list + tools/call", async () => {
  const port = await freePort();
  const relay = await startRelay({ port });
  await relay.ready;

  const shim = startShim({ port, key: relay.key });
  const init = await shim.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shim-test", version: "0.0.0" },
  });
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(init.serverInfo.name, "fake-xcode");
  shim.notify("notifications/initialized");
  const list = await shim.request("tools/list", {});
  assert.deepEqual(list.tools.map((t) => t.name), ["EchoTool", "PingTool"]);
  const call = await shim.request("tools/call", {
    name: "EchoTool",
    arguments: { tag: "roundtrip" },
  });
  assert.match(call.content[0].text, /"tag":"roundtrip"/);
  assert.match(call.content[0].text, /pid \d+/);

  // Clean shutdown: closing the local client's stdin -> shim exits 0.
  shim.child.stdin.end();
  assert.equal(await shim.exitCode(), 0);
  relay.child.kill("SIGTERM");
});

// ---------------------------------------------------------------------------
// (b) relay side closes -> shim exits nonzero with a stderr message
// ---------------------------------------------------------------------------
test("shim: relay closes -> nonzero exit + stderr message", async () => {
  const port = await freePort();
  const relay = await startRelay({ port });
  await relay.ready;

  const shim = startShim({ port, key: relay.key });
  const init = await shim.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shim-test", version: "0.0.0" },
  });
  assert.equal(init.serverInfo.name, "fake-xcode");

  relay.child.kill("SIGKILL"); // simulate the relay going away
  const code = await shim.exitCode();
  assert.notEqual(code, 0, "shim must exit nonzero when the relay connection is lost");
  assert.match(shim.stderr, /relay connection closed/);
  assert.match(shim.stderr, /code=\d+/);
});

// ---------------------------------------------------------------------------
// (c) missing env -> exit 1
// ---------------------------------------------------------------------------
test("shim: missing MCP_RELAY_URL / MCP_RELAY_KEY -> exit 1", async () => {
  for (const missing of [
    ["MCP_RELAY_URL", "MCP_RELAY_KEY"],
    ["MCP_RELAY_KEY"],
  ]) {
    const child = track(
      spawn(process.execPath, [SHIM], { env: envWithout(missing), stdio: ["pipe", "pipe", "pipe"] }),
    );
    let out = "";
    child.stderr.on("data", (d) => (out += d.toString()));
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stdin.end();
    const code = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("shim did not exit")), 10000);
      child.on("exit", (c) => {
        clearTimeout(t);
        res(c);
      });
    });
    assert.equal(code, 1, `expected exit 1 with missing ${missing.join(", ")}`);
    for (const v of ["MCP_RELAY_URL", "MCP_RELAY_KEY"]) assert.match(out, new RegExp(v));
  }
});

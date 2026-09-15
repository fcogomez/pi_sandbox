#!/usr/bin/env node
/**
 * pi-sandbox MCP bridge
 *
 * Exposes the `pi` coding agent (running in this container) to MCP clients
 * (Hermes) over HTTP/StreamableHTTP. Runs as a persistent daemon inside the
 * pi-sandbox container; tasks are executed as serial `pi -p --mode json`
 * child processes scoped to subdirectories of /home/pi/workspace.
 *
 * Env:
 *   PI_MCP_PORT            default 3103
 *   PI_MCP_HOST            default 0.0.0.0
 *   PI_MCP_API_KEY         REQUIRED (no fallback to open access)
 *   PI_WORKSPACE           default /home/pi/workspace
 *   PI_BIN                 default "pi"
 *   PI_TIMEOUT_SECONDS     default 3600 (per-task hard timeout)
 *   PI_MAX_OUTPUT_CHARS    default 200000 (truncate final text returned to client)
 *
 * Security:
 *   - Authorization: Bearer <PI_MCP_API_KEY> required on every request.
 *   - workdir is resolved, canonicalized, and must stay inside PI_WORKSPACE.
 *   - At most one pi process at a time (serial queue).
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const PORT = parseInt(process.env.PI_MCP_PORT || '3103', 10);
const HOST = process.env.PI_MCP_HOST || '0.0.0.0';
const API_KEY = process.env.PI_MCP_API_KEY || '';
const WORKSPACE = path.resolve(process.env.PI_WORKSPACE || '/home/pi/workspace');
const PI_BIN = process.env.PI_BIN || 'pi';
const PI_TIMEOUT = parseInt(process.env.PI_TIMEOUT_SECONDS || '3600', 10);
const MAX_OUTPUT = parseInt(process.env.PI_MAX_OUTPUT_CHARS || '200000', 10);
const MEMORY_PROMPT_FILE = '/tmp/.pi-mem-prompt';

if (!API_KEY) {
  console.error('[pi-mcp] FATAL: PI_MCP_API_KEY is not set; refusing to start open.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Memory protocol (shared with Hermes via /home/pi/memory)
// ---------------------------------------------------------------------------
const MEMORY_DIR = '/home/pi/memory';

function readMemoryPrompt() {
  try {
    if (fs.existsSync(MEMORY_PROMPT_FILE)) return fs.readFileSync(MEMORY_PROMPT_FILE, 'utf8').trim();
  } catch (_) { /* fall through */ }
  if (!fs.existsSync(MEMORY_DIR)) return '';
  return [
    '',
    '## Shared memory protocol',
    `You have a shared memory folder at ${MEMORY_DIR} (format: ${MEMORY_DIR}/PROTOCOL.md).`,
    `Before starting a task, run: bash ${MEMORY_DIR}/pi-mem.sh show 3   (if pi-mem.sh exists)`,
    `When your task finishes, append one entry to ${MEMORY_DIR}/log/$(date +%F).md using the format in PROTOCOL.md.`,
    'Never write secrets into these files.',
  ].join('\n');
}

function logMemoryEntry(taskId, goal, ok, summary, ms) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(MEMORY_DIR, 'log');
    fs.mkdirSync(dir, { recursive: true });
    const line = [
      `### ${new Date().toISOString()} — MCP task ${taskId}`,
      `- origin: hermes-mcp`,
      `- goal: ${goal.replace(/\s+/g, ' ').slice(0, 400)}`,
      `- status: ${ok ? 'ok' : 'FAILED'} (${Math.round(ms / 1000)}s)`,
      `- summary: ${summary.replace(/\s+/g, ' ').slice(0, 600)}`,
      '',
    ].join('\n');
    fs.appendFileSync(path.join(dir, `${day}.md`), line);
  } catch (e) {
    console.error('[pi-mcp] memory log failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// workdir safety
// ---------------------------------------------------------------------------
function resolveWorkdir(input) {
  const raw = input || '.';
  let p = path.resolve(WORKSPACE, raw);
  // Normalize and ensure it stays inside the mounted workspace.
  const rel = path.relative(WORKSPACE, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`workdir escapes the sandbox workspace: ${input}`);
  }
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------------------
// Task runner (serial)
// ---------------------------------------------------------------------------
const tasks = new Map(); // id -> task record
let queue = [];
let running = false;

function newTaskId() {
  return 't' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function gitHead(workdir) {
  try {
    return spawnSyncGit(workdir, ['rev-parse', 'HEAD']);
  } catch (_) { return null; }
}

function spawnSyncGit(cwd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
}

function gitChangedFiles(workdir, beforeHead) {
  try {
    const { execFileSync } = require('child_process');
    const out = [];
    try {
      out.push(...execFileSync('git', ['status', '--porcelain'], { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean));
    } catch (_) { /* not a repo / no git */ }
    if (beforeHead) {
      try {
        out.push(...execFileSync('git', ['diff', '--name-only', beforeHead, 'HEAD'], { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean));
      } catch (_) { /* fine */ }
    }
    return [...new Set(out)].map((l) => l.replace(/^..\s?/, ''));
  } catch (_) { return []; }
}

function runPi(task) {
  return new Promise((resolve) => {
    const args = ['-p', '--mode', 'json'];
    const memPrompt = readMemoryPrompt();
    if (memPrompt) args.push('--append-system-prompt', memPrompt);
    args.push(task.goal);

    task.status = 'running';
    task.startedAt = Date.now();
    const beforeHead = gitHead(task.workdir);
    const child = spawn(PI_BIN, args, {
      cwd: task.workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    task._child = child;

    let stderr = '';
    let lastEvent = null;
    let fullOut = ''; // complete stdout for post-run parsing
    let finished = false;
    let exitCode = null;
    let timedOut = false;
    const t0 = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      task.status = 'timeout';
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 10000);
    }, PI_TIMEOUT * 1000);

    child.stdout.on('data', (d) => {
      fullOut += d.toString();
      // Incremental progress: drain complete lines, keep the trailing fragment.
      const lines = fullOut.split('\n');
      const tail = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          lastEvent = JSON.parse(line);
          const t = lastEvent.type || '';
          if (t === 'message' || t === 'message_update' || t === 'tool_result' || t === 'tool_execution_update' || t === 'turn_end') {
            task.progress = t;
            task.progressAt = Date.now();
          }
        } catch (_) { /* non-JSON line; ignore */ }
      }
      // Note: we intentionally keep fullOut intact (not truncated) so the
      // trailing tail is still available for the final parse.
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      exitCode = -1;
      stderr += `\nspawn error: ${err.message}`;
      finalize();
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      exitCode = code;
      // Progress-tracking already consumed complete lines; the final parse
      // in finalize() reads fullOut, so nothing extra to flush here.
      finalize();
    });

    function finalize() {
      const ms = Date.now() - t0;
      const ok = !timedOut && exitCode === 0;
      const parsed = parsePiOutput(fullOut);
      task.finishedAt = Date.now();
      task.durationMs = ms;
      task.exitCode = exitCode;
      task.ok = ok && parsed.ok;
      task.finalText = parsed.finalText;
      task.error = timedOut
        ? `Task exceeded ${PI_TIMEOUT}s hard timeout and was killed.`
        : (ok ? (parsed.error || '') : `pi exited with code ${exitCode}${parsed.error ? ': ' + parsed.error : ''}${stderr ? ' | stderr: ' + stderr.slice(-2000) : ''}`);
      task.status = task.ok ? 'done' : 'error';
      task.changedFiles = gitChangedFiles(task.workdir, beforeHead);
      logMemoryEntry(task.id, task.goal, task.ok, task.ok ? (parsed.finalText || 'done').slice(0, 600) : task.error, ms);
      resolve(task);
    }
  });
}

/**
 * Parse `pi -p --mode json` output (verified against pi 0.85.1).
 *
 * Real event stream (JSONL):
 *   session, agent_start, turn_start,
 *   message_start / message_update (xN) / message_end   (per message; message has role+content[])
 *   turn_end  { message: assistant msg, toolResults }   (per turn; carries the turn's assistant msg)
 *   agent_end { messages: [all msgs], willRetry }       (final; last assistant msg = answer)
 *   agent_settled
 * Content blocks: { type: "thinking" | "text" | "toolCall" | ..., text? }.
 * Final answer = concatenated `text` blocks of the LAST assistant message.
 *
 * Returns { ok, finalText, error }.
 */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

function parsePiOutput(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  let finalText = '';
  let error = '';
  let sawAgentEnd = false;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch (_) { continue; }
    const t = ev.type || '';

    if (t === 'message_end' || t === 'turn_end') {
      const m = ev.message || {};
      if (m.role === 'assistant') finalText = textFromContent(m.content);
    } else if (t === 'agent_end') {
      sawAgentEnd = true;
      const msgs = Array.isArray(ev.messages) ? ev.messages : [];
      const assistant = [...msgs].reverse().find((m) => m && m.role === 'assistant');
      if (assistant) finalText = textFromContent(assistant.content);
    }
    // Legacy / alternate shapes (kept for forward/backward compatibility):
    else if (t === 'message') {
      const m = ev.message || ev;
      if (m.role === 'assistant') finalText = textFromContent(m.content);
    } else if (t === 'result') {
      if (typeof ev.result === 'string') finalText = ev.result;
      else if (ev.result && typeof ev.result.text === 'string') finalText = ev.result.text;
      if (ev.isError || ev.error) error = typeof ev.error === 'string' ? ev.error : 'pi reported an error';
    } else if (t === 'error') {
      error = typeof ev.message === 'string' ? ev.message : JSON.stringify(ev).slice(0, 500);
    }
  }

  let ok = !error && lines.length > 0;
  // No events at all, or an agent_end without any assistant text => suspicious.
  if (sawAgentEnd && !finalText.trim()) {
    ok = false;
    error = error || 'pi finished but produced no assistant text';
  }
  if (finalText.length > MAX_OUTPUT) {
    finalText = finalText.slice(0, MAX_OUTPUT) + `\n[truncated at ${MAX_OUTPUT} chars]`;
  }
  return { ok, finalText, error };
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const task = queue.shift();
    console.log(`[pi-mcp] start ${task.id} in ${task.workdir}: ${task.goal.slice(0, 80)}`);
    await runPi(task);
    console.log(`[pi-mcp] ${task.status} ${task.id} in ${task.durationMs}ms`);
  }
  running = false;
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
function createMcpServer() {
  const s = new McpServer({ name: 'pi-sandbox', version: '1.0.0' });

  s.tool(
    'pi_task_submit',
    'Queue a coding task for the pi agent (serial queue; one task at a time). Returns a task_id immediately; use pi_task_wait for the result. workdir is a subdirectory of the sandbox workspace (e.g. "projects/TruckNav").',
    {
      goal: z.string().describe('Full task instruction for the agent. Be specific about files, scope, and acceptance criteria.'),
      workdir: z.string().optional().describe('Project subdirectory under the sandbox workspace (relative, e.g. "projects/TruckNav"). Default: workspace root.'),
    },
    async ({ goal, workdir }) => {
      let wd;
      try { wd = resolveWorkdir(workdir); } catch (e) { return { content: [{ type: 'text', text: e.message }] }; }
      const task = {
        id: newTaskId(), goal, workdir: wd, status: 'queued',
        submittedAt: Date.now(),
      };
      tasks.set(task.id, task);
      queue.push(task);
      setImmediate(pump);
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: task.id, status: 'queued', position: queue.length, workdir: wd }) }] };
    }
  );

  s.tool(
    'pi_task_wait',
    'Wait for a queued/running pi task to finish. Returns immediately with the result if the task is done, or with current progress if still working (call again later).',
    {
      task_id: z.string(),
      timeout_s: z.number().optional().describe('Max seconds to block waiting (default 600, hard cap 3500). 0 = return current state instantly.'),
    },
    async ({ task_id, timeout_s }) => {
      const task = tasks.get(task_id);
      if (!task) return { content: [{ type: 'text', text: `unknown task_id: ${task_id}` }] };
      const cap = 3500;
      const want = Math.min(Math.max(Number(timeout_s) || 600, 0), cap);
      const deadline = Date.now() + want * 1000;
      while (['queued', 'running'].includes(task.status)) {
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      return { content: [{ type: 'text', text: JSON.stringify(summarize(task), null, 2) }] };
    }
  );

  s.tool(
    'pi_task_log',
    'Get progress/summary for a pi task without blocking (status, elapsed time, last event).',
    {
      task_id: z.string(),
    },
    async ({ task_id }) => {
      const task = tasks.get(task_id);
      if (!task) return { content: [{ type: 'text', text: `unknown task_id: ${task_id}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(summarize(task, true), null, 2) }] };
    }
  );

  s.tool(
    'pi_task_list',
    'List pi tasks (newest first) with their status.',
    {},
    async () => {
      const rows = [...tasks.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 50)
        .map((t) => ({ id: t.id, status: t.status, goal: t.goal.slice(0, 100), submitted_at: new Date(t.submittedAt).toISOString() }));
      return { content: [{ type: 'text', text: JSON.stringify({ running: running, queued: queue.length, tasks: rows }, null, 2) }] };
    }
  );

  s.tool(
    'pi_health',
    'Health check: pi binary/version, loaded model/provider config, vLLM endpoint reachability, queue state.',
    {},
    async () => {
      const out = { ok: true, queue: { running: running, queued: queue.length } };
      try {
        const { execFileSync } = require('child_process');
        out.pi_version = execFileSync(PI_BIN, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
      } catch (e) {
        out.ok = false;
        out.pi_version = `error: ${e.message}`;
      }
      try {
        const dir = process.env.PI_CODING_AGENT_DIR || '/home/pi/.pi/agent';
        const mj = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
        out.providers = Object.fromEntries(Object.entries(mj.providers || {}).map(([k, v]) => [k, { baseUrl: v.baseUrl, models: (v.models || []).map((m) => m.id) }]));
      } catch (e) {
        out.providers = `error: ${e.message}`;
      }
      // vLLM reachability
      try {
        const providerObj = out.providers && typeof out.providers === 'object' ? Object.values(out.providers)[0] : null;
        const baseUrl = providerObj && providerObj.baseUrl;
        if (baseUrl) {
          const res = await fetch(baseUrl.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(5000) });
          out.vllm = { url: baseUrl, reachable: res.ok };
          if (res.ok) {
            const j = await res.json();
            out.vllm.models = (j.data || []).map((m) => m.id);
          }
        }
      } catch (e) {
        out.vllm = { reachable: false, error: e.message };
      }
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }
  );

  s.tool(
    'pi_memory_show',
    'Show recent entries from the shared pi/Hermes memory (MEMORY.md + last N days of log).',
    {
      days: z.number().optional().describe('Days of log to include (default 3, max 14).'),
    },
    async ({ days }) => {
      const n = Math.min(Math.max(Number(days) || 3, 1), 14);
      const parts = [];
      try {
        const mem = path.join(MEMORY_DIR, 'MEMORY.md');
        if (fs.existsSync(mem)) parts.push('# MEMORY.md\n' + fs.readFileSync(mem, 'utf8'));
      } catch (_) {}
      try {
        const logDir = path.join(MEMORY_DIR, 'log');
        const files = fs.existsSync(logDir)
          ? fs.readdirSync(logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, n)
          : [];
        for (const f of files) {
          parts.push(`# log/${f}\n` + fs.readFileSync(path.join(logDir, f), 'utf8'));
        }
      } catch (_) {}
      if (parts.length === 0) return { content: [{ type: 'text', text: 'shared memory is empty' }] };
      return { content: [{ type: 'text', text: parts.join('\n\n').slice(0, MAX_OUTPUT) }] };
    }
  );

  return s;
}

function summarize(task, brief = false) {
  const base = {
    task_id: task.id,
    status: task.status,
    goal: task.goal.slice(0, 200),
    workdir: task.workdir,
    submitted_at: new Date(task.submittedAt).toISOString(),
  };
  if (task.startedAt) base.started_at = new Date(task.startedAt).toISOString();
  if (task.status === 'running' || task.status === 'queued') {
    base.elapsed_s = Math.round((Date.now() - (task.startedAt || task.submittedAt)) / 1000);
    base.last_event = task.progress || null;
    return base;
  }
  base.finished_at = task.finishedAt ? new Date(task.finishedAt).toISOString() : null;
  base.duration_s = Math.round((task.durationMs || 0) / 1000);
  base.exit_code = task.exitCode;
  if (!brief) base.final_text = task.finalText || '';
  if (task.error) base.error = task.error;
  if (task.changedFiles && task.changedFiles.length) base.changed_files = task.changedFiles;
  return base;
}

// ---------------------------------------------------------------------------
// HTTP layer (stateless: fresh transport + server per POST)
//   The task queue / state lives at module level and survives requests;
//   each POST gets its own McpServer + StreamableHTTPServerTransport,
//   closed when the response ends.
// ---------------------------------------------------------------------------
function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // constant-time-ish compare
  const a = Buffer.from(m[1]);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleMcpPost(req, res, send) {
  const raw = await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
  let parsed;
  try { parsed = JSON.parse(raw || '{}'); } catch (_) { return send(400, { error: 'invalid json' }); }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);

  // Ensure the transport is always torn down (also on client disconnect).
  res.on('close', () => { transport.close().catch(() => {}); });

  await transport.handleRequest(req, res, parsed);
}

const server = http.createServer(async (req, res) => {
  const send = (code, body, headers = {}) => {
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  if (req.url === '/health') {
    if (!checkAuth(req)) return send(401, { error: 'unauthorized' });
    return send(200, { ok: true, service: 'pi-sandbox-mcp', running, queued: queue.length });
  }

  if (!checkAuth(req)) return send(401, { error: 'unauthorized' });

  // Only the MCP endpoint
  if (req.url !== '/mcp' && !req.url.startsWith('/mcp?')) {
    return send(404, { error: 'not found' });
  }

  if (req.method !== 'POST') {
    // Stateless mode: no SSE stream endpoint, no session teardown needed.
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }

  try {
    await handleMcpPost(req, res, send);
  } catch (e) {
    console.error('[pi-mcp] request error:', e);
    return send(500, { error: 'handler: ' + e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[pi-mcp] listening on http://${HOST}:${PORT}/mcp (stateless, bearer auth required)`);
});

process.on('SIGTERM', () => {
  console.log('[pi-mcp] SIGTERM; shutting down (in-flight task will be orphaned)');
  process.exit(0);
});

// Surface errors that escape per-request handling (debug aid; keep logs clean in prod via PI_MCP_QUIET)
process.on('uncaughtException', (e) => {
  if (process.env.PI_MCP_QUIET === '1') return;
  console.error('[pi-mcp] uncaughtException:', e);
});
process.on('unhandledRejection', (e) => {
  if (process.env.PI_MCP_QUIET === '1') return;
  console.error('[pi-mcp] unhandledRejection:', e);
});

#!/usr/bin/env node
/**
 * mac-ops — allowlist MCP server (stdio, NDJSON JSON-RPC 2.0).
 *
 * Run behind the agent-tools relay daemon as a SECOND relay instance:
 *
 *   consumer (WS, bearer)  <->  relay.mjs (port 3130)  <->  node mac-ops.mjs
 *
 * It exposes ONLY fixed operations. There is NO free-form command
 * execution: every tool is a hardcoded command with validated arguments,
 * spawned without a shell (argv arrays only).
 *
 * Tools (git tools all take a REQUIRED `repo` parameter — absolute path
 * to the git repo the call operates on; validated per call, nothing is
 * pinned at install time):
 *   xcode_cleanup          delete Xcode build artifacts (fixed paths only)
 *   git_status             git status   {repo}
 *   git_log                git log --oneline {repo, count?}
 *   git_diff               git diff --stat {repo, cached?}
 *   git_branch_list        git branch -vv {repo}
 *   git_remote             git remote -v {repo}
 *   git_fetch              git fetch --prune {repo}
 *   git_checkout           git checkout <branch> {repo, branch}
 *   git_pull               git pull --ff-only {repo}
 *   git_push               git push [origin <branch>] {repo, branch?}
 *
 * Safety model:
 *   - git: cwd is the `repo` argument, validated on EVERY call (absolute
 *     path, exists, is a git repo). Subcommands are a closed set; no
 *     `git config`, no remote mutation, no credential handling.
 *   - cleanup: candidate paths are derived from $HOME / the per-user
 *     temp dir, re-validated against strict prefixes BEFORE deletion.
 *   - audit: every invocation (tool, repo, args, exit/size) is appended
 *     as JSONL to the audit log.
 *
 * Audit log: ~/Library/Logs/mac-ops.log (JSONL; args are logged — they
 * are short, validated identifiers/paths, never secrets).
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, isDirectory, join } from "node:path";
import process from "node:process";

const SERVER_NAME = "mac-ops";
const SERVER_VERSION = "1.1.0";
const PROTOCOL_VERSION = "2024-11-05";

const AUDIT_LOG =
  process.env.MAC_OPS_AUDIT_LOG ||
  join(homedir(), "Library/Logs/mac-ops.log");

function logStderr(msg) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg }) + "\n");
}

function audit(entry) {
  try {
    appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Audit must never break a call.
  }
}

function textResult(obj, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// xcode_cleanup — fixed artifact paths, prefix-validated before deletion
// ---------------------------------------------------------------------------
const HOME = homedir();

function derivedDataPath() {
  return join(HOME, "Library/Developer/Xcode/DerivedData");
}

/** Per-user temp dir on macOS (Xcode writes ActionArtifacts under it). */
function darwinUserTempDir() {
  const r = spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const out = (r.stdout || "").trim();
  if (r.status === 0 && isAbsolute(out) && out.endsWith("/T/")) {
    return out;
  }
  return null;
}

function resolveTarget(kind) {
  if (kind === "derived_data") {
    return { label: "DerivedData", path: derivedDataPath(), allowedRoot: HOME };
  }
  const tmp = darwinUserTempDir();
  if (!tmp) return null; // not macOS / not resolvable
  const p = join(tmp, "ActionArtifacts");
  return { label: "xcresult (ActionArtifacts)", path: p, allowedRoot: "/var/folders/" };
}

function dirSizeKB(p) {
  const r = spawnSync("du", ["-sk", p], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  const n = parseInt((r.stdout || "").trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : null;
}

function cleanupOne(kind) {
  const target = resolveTarget(kind);
  if (!target) {
    return { target: kind, state: "skipped", reason: "path not resolvable on this host" };
  }
  const { path, allowedRoot, label } = target;
  if (!existsSync(path)) {
    return { target: kind, state: "skipped", reason: "not present", path };
  }
  // Security gate: the REAL path must stay under the allowed root and
  // match the expected label — never follow a symlink out of the root.
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return { target: kind, state: "skipped", reason: "cannot resolve path", path };
  }
  if (!real.startsWith(allowedRoot + "/") && real !== allowedRoot) {
    logStderr(`cleanup REFUSED: ${real} escapes ${allowedRoot}`);
    return { target: kind, state: "refused", reason: "path escaped allowed root", path: real };
  }
  const st = lstatSync(path);
  if (!st.isDirectory()) {
    return { target: kind, state: "refused", reason: "not a directory", path };
  }
  const sizeKB = dirSizeKB(path);
  const rm = spawnSync("rm", ["-rf", path], { encoding: "utf8", timeout: 300000 });
  const ok = rm.status === 0 && !existsSync(path);
  audit({ tool: "xcode_cleanup", kind, path: real, sizeKB, ok });
  return {
    target: kind,
    label,
    path: real,
    sizeKB,
    state: ok ? "deleted" : "failed",
    ...(ok ? {} : { reason: (rm.stderr || "").slice(0, 200) || `rm exit ${rm.status}` }),
  };
}

function toolXcodeCleanup(args) {
  const target = args && args.target;
  const kinds = target === "derived_data" ? ["derived_data"]
    : target === "xcresult" ? ["xcresult"]
    : target === "both" ? ["derived_data", "xcresult"]
    : null;
  if (!kinds) {
    return textResult({ error: 'target must be "derived_data" | "xcresult" | "both"' }, true);
  }
  const results = kinds.map(cleanupOne);
  const failed = results.some((r) => r.state === "failed" || r.state === "refused");
  return textResult({ results }, failed);
}

// ---------------------------------------------------------------------------
// git tools — repo is a REQUIRED per-call parameter; closed subcommand set,
// validated args, no shell
// ---------------------------------------------------------------------------
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * Validate the per-call `repo` parameter. Returns { error } on failure or
 * { repo } (realpath-resolved) on success.
 */
function validateRepo(args) {
  const p = args && args.repo;
  if (typeof p !== "string" || !p.trim()) {
    return { error: "repo is required: absolute path to the git repo" };
  }
  const path = p.trim();
  if (!isAbsolute(path)) {
    return { error: `repo must be an absolute path (got: ${path})` };
  }
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return { error: `repo path does not exist: ${path}` };
  }
  if (!isDirectory(real)) {
    return { error: `repo path is not a directory: ${path}` };
  }
  if (!existsSync(join(real, ".git"))) {
    return { error: `not a git repository (no .git): ${real}` };
  }
  return { repo: real };
}

function runGit(args, argv) {
  const v = validateRepo(args);
  if (v.error) return textResult(v, true);
  const r = spawnSync("git", argv, {
    cwd: v.repo,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  if (r.error) {
    return textResult({ error: `git failed to run: ${r.error.message}` }, true);
  }
  audit({
    tool: `git_${argv[0]}`,
    repo: v.repo,
    argv: argv.slice(1).join(" ").slice(0, 120),
    exit: r.status,
  });
  return textResult({
    repo: v.repo,
    argv: ["git", ...argv],
    exitCode: r.status,
    stdout: (r.stdout || "").slice(0, 200000),
    stderr: (r.stderr || "").slice(0, 20000),
  }, r.status !== 0);
}

const REPO_PROP = {
  repo: {
    type: "string",
    description: "Absolute path to the git repository this call operates on.",
  },
};

function toolGitStatus(args) {
  return runGit(args, ["status", "--porcelain=v1", "-b"]);
}

function toolGitLog(args) {
  let n = 20;
  if (args && args.count !== undefined) {
    n = parseInt(args.count, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return textResult({ error: "count must be an integer 1..100" }, true);
    }
  }
  return runGit(args, ["log", "--oneline", String(n)]);
}

function toolGitDiff(args) {
  const argv = ["diff", "--stat"];
  if (args && args.cached === true) argv.push("--cached");
  return runGit(args, argv);
}

function toolGitBranchList(args) {
  return runGit(args, ["branch", "-vv"]);
}

function toolGitRemote(args) {
  return runGit(args, ["remote", "-v"]);
}

function toolGitFetch(args) {
  return runGit(args, ["fetch", "--prune"]);
}

function toolGitCheckout(args) {
  const b = args && args.branch;
  if (typeof b !== "string" || !BRANCH_RE.test(b)) {
    return textResult({ error: "invalid branch name" }, true);
  }
  return runGit(args, ["checkout", b]);
}

function toolGitPull(args) {
  return runGit(args, ["pull", "--ff-only"]);
}

function toolGitPush(args) {
  if (!args || args.branch === undefined) return runGit(args, ["push"]);
  const b = args.branch;
  if (typeof b !== "string" || !BRANCH_RE.test(b)) {
    return textResult({ error: "invalid branch name" }, true);
  }
  return runGit(args, ["push", "origin", b]);
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "xcode_cleanup",
    description:
      "Delete Xcode build artifacts. target: 'derived_data' (~/Library/Developer/Xcode/DerivedData), " +
      "'xcresult' (per-user temp ActionArtifacts dir), or 'both'. Fixed paths only; " +
      "each path is prefix-validated before deletion. Reports size + state per target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["derived_data", "xcresult", "both"] },
      },
      required: ["target"],
    },
    run: toolXcodeCleanup,
  },
  {
    name: "git_status",
    description: "git status --porcelain=v1 -b. repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP },
      required: ["repo"],
    },
    run: toolGitStatus,
  },
  {
    name: "git_log",
    description: "git log --oneline (count 1..100, default 20). repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP, count: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["repo"],
    },
    run: toolGitLog,
  },
  {
    name: "git_diff",
    description:
      "git diff --stat (working tree, or --cached with cached:true). repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP, cached: { type: "boolean" } },
      required: ["repo"],
    },
    run: toolGitDiff,
  },
  {
    name: "git_branch_list",
    description: "git branch -vv (local branches + upstream tracking). repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP },
      required: ["repo"],
    },
    run: toolGitBranchList,
  },
  {
    name: "git_remote",
    description: "git remote -v. repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP },
      required: ["repo"],
    },
    run: toolGitRemote,
  },
  {
    name: "git_fetch",
    description: "git fetch --prune. repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP },
      required: ["repo"],
    },
    run: toolGitFetch,
  },
  {
    name: "git_checkout",
    description:
      "git checkout <branch> (branch regex-validated). repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP, branch: { type: "string" } },
      required: ["repo", "branch"],
    },
    run: toolGitCheckout,
  },
  {
    name: "git_pull",
    description: "git pull --ff-only (refuses to merge). repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP },
      required: ["repo"],
    },
    run: toolGitPull,
  },
  {
    name: "git_push",
    description:
      "git push: no branch pushes the current branch upstream; branch -> git push origin <branch>. " +
      "Never --force. repo: absolute path to the git repo.",
    inputSchema: {
      type: "object",
      properties: { ...REPO_PROP, branch: { type: "string" } },
      required: ["repo"],
    },
    run: toolGitPush,
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdin/stdout (NDJSON) — the relay.mjs child contract
// ---------------------------------------------------------------------------
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return; // no response
  }
  if (method === "tools/list") {
    respond(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      if (isNotification) return;
      respondError(id, -32601, `unknown tool: ${name}`);
      return;
    }
    try {
      const result = tool.run(args);
      if (isNotification) return;
      respond(id, result);
    } catch (err) {
      audit({ tool: name, error: String(err && err.message || err) });
      if (isNotification) return;
      respond(id, textResult({ error: String(err && err.message || err) }, true));
    }
    return;
  }
  if (isNotification) return;
  respondError(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logStderr(`bad frame: ${line.slice(0, 200)}`);
      continue;
    }
    try {
      handle(msg);
    } catch (err) {
      logStderr(`handler error: ${err && err.message}`);
      if (msg.id !== undefined) respondError(msg.id, -32603, "internal error");
    }
  }
});
process.stdin.on("close", () => process.exit(0));
logStderr(`${SERVER_NAME} v${SERVER_VERSION} ready (repo: per-call parameter)`);

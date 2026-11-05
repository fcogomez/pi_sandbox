import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type Usage,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_FS_DELEGATION,
  DEFAULT_GATED_TOOLS,
  DEFAULT_THINKING_LEVEL,
  type AcpConfig,
  type ThinkingLevel,
} from "./config.js";
import { handleReadDelegation, READ_TITLE_PREFIX } from "./fs-delegation.js";
import {
  parsePermTitle,
  requestToolPermission,
  type PermissionOutcome,
} from "./permissions.js";
import { PiRpc, type PiRecord, type PiSpawner } from "./pi-rpc.js";
import { SessionMap, type SessionMapEntry } from "./session-map.js";
import { piToolEventToAcpUpdate, toolNameToKind } from "./tool-mapping.js";
import { ThinkingController } from "./thinking.js";

/**
 * Absolute path of the standalone pi extension (permission gate + read
 * override). pi-extension.ts lives at the package root and is NOT compiled
 * by tsup — pi loads it via `-e` with its own tsx loader. From either
 * `src/` (tsx/tests) or `dist/` (tsup output), `..` resolves to the
 * package root. Never use process.cwd(): the session's params.cwd is the
 * project directory, not the package directory.
 */
export const PI_EXTENSION_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "pi-extension.ts",
);

export interface AcpAgentOptions {
  config?: AcpConfig;
  /** Spawner seam for the pi subprocess (tests inject an in-process fake). */
  spawner?: PiSpawner;
  /** Path of the pi extension loaded via `-e` (default: the bundled one). */
  extensionPath?: string;
  log?: (message: string) => void;
}

interface ManagedSession {
  rpc: PiRpc;
  thinking: ThinkingController;
  cwd: string;
  /** Thinking levels the model supports (as reported by pi). */
  availableLevels: ThinkingLevel[];
  /** Level currently in effect for this session. */
  thinkingLevel: ThinkingLevel;
  promptInFlight: boolean;
  /**
   * A3: set by `session/cancel` while a prompt is in flight; the in-flight
   * `prompt()` observes it and returns `stopReason: "cancelled"`. Cleared
   * when the prompt settles.
   */
  cancelRequested: boolean;
  /** Usage reported by the last agent_end for the in-flight prompt. */
  lastUsage: Usage | null;
  /** A3: pi's own session id (from `get_state`), if known. */
  piSessionId: string | null;
  /** A3: absolute path of pi's session file (from `get_state`), if known. */
  sessionFile: string | null;
  /** A3: ISO timestamp of session registration (mirrors the disk map). */
  createdAt: string;
  /** A3: ISO timestamp of the most recent use (mirrors the disk map). */
  lastUsedAt: string;
  /** Unsubscribe from pi extension_ui_request records. */
  unsubscribeUi?: () => void;
  /**
   * B2: the in-flight `session/prompt` turn, or null when none is in flight.
   * Real pi's `prompt` command responds at ACCEPTANCE (the turn then streams
   * and the session file is written ~1s later); the ACP `session/prompt`
   * promise must instead resolve at TURN COMPLETION (the `agent_settled`
   * event). So the RPC is fire-and-forget (rejection settles the promise as
   * an error) and `resolveTurn` is what `handlePiEvent` calls on
   * `agent_settled`.
   */
  promptTurn?: {
    resolve: (r: { stopReason: "end_turn" | "cancelled"; usage: Usage | null }) => void;
    reject: (e: Error) => void;
  } | null;
}

/** Result of spawning + wiring a fresh pi subprocess for an ACP session. */
interface SpawnedSession {
  rpc: PiRpc;
  thinking: ThinkingController;
  availableLevels: ThinkingLevel[];
  thinkingLevel: ThinkingLevel;
}

/**
 * ACP agent backed by a `pi --mode rpc` subprocess (tickets ACP-A1/A2).
 *
 * A1 scope:
 *   - `initialize`      — handshake + capability exchange
 *   - `session/new`     — spawn pi, report available thinking levels, apply
 *                         the configured default thinking level
 *   - `session/prompt`  — stream pi's run back as ACP session updates
 *   - pi-RPC-side thinking controls (set / get_available / cycle / get_state)
 *
 * A2 scope:
 *   - pi is spawned with the bundled extension (`-e acp/pi-extension.ts`)
 *     plus `ACP_FS_DELEGATION` / `ACP_GATED_TOOLS` env vars
 *   - tool execution events (tool_execution_start/update/end) are mapped to
 *     ACP `tool_call` / `tool_call_update` session updates (src/tool-mapping.ts)
 *   - the extension's permission select (`[acp:perm] ...`) is bridged to
 *     ACP `session/request_permission` and the selected option is written
 *     back to pi (src/permissions.ts)
 *   - the extension's read delegation input (`[acp:read] <path>`) is bridged
 *     to ACP `fs/read_text_file` (src/fs-delegation.ts); unsupported clients
 *     get `cancelled: true` so the extension falls back locally
 *
 * A3 scope:
 *   - session map persisted as a JSON file (src/session-map.ts): populated
 *     in `session/new` from pi `get_state`, refreshed on load/resume
 *   - `session/load`   — spawn fresh pi, `switch_session` to the persisted
 *     session file, re-apply the persisted thinking level, and replay the
 *     history (`get_messages`) as ACP session updates before responding
 *   - `session/resume` — same as load, without the history replay
 *   - `session/cancel` — sets a cancel flag + sends pi `abort`; the
 *     in-flight `prompt()` resolves with `stopReason: "cancelled"`.
 *     Unknown session: log + resolve (cancel is a notification, never an
 *     error). Cancel never kills the pi child.
 *   - `initialize` advertises exactly
 *     `{ loadSession: true, sessionCapabilities: { resume: {} } }`
 *
 * NOT in A3 (deferred, do not advertise):
 *   - `session/list`, `session/delete`, `session/fork`, `session/close`
 *   - ACP runtime `session/set_mode` / `session/set_config_option` override
 *     of the thinking level
 *   - fs/write_text_file delegation, persistent "always allow/reject",
 *     MCP server wiring (load/resume `mcpServers` are accepted + ignored)
 */
export class PiAcpAgent implements Agent {
  private readonly config: AcpConfig;
  private readonly spawner?: PiSpawner;
  private readonly extensionPath: string;
  private readonly log: (message: string) => void;
  private connection: AgentSideConnection | null = null;
  private readonly sessions = new Map<string, ManagedSession>();
  /** A3: on-disk session map (load/put/touch/remove, atomic writes). */
  private readonly sessionMap: SessionMap;
  /** A3: whether the on-disk map has been loaded into memory yet. */
  private mapLoaded = false;
  /** Client capabilities captured during initialize. */
  clientCapabilities: InitializeRequest["clientCapabilities"] = undefined;
  /** Client implementation info captured during initialize. */
  clientInfo: InitializeRequest["clientInfo"] = undefined;
  private initialized = false;

  constructor(options: AcpAgentOptions = {}) {
    this.config = options.config ?? { thinkingLevel: DEFAULT_THINKING_LEVEL };
    this.spawner = options.spawner;
    this.extensionPath = options.extensionPath ?? PI_EXTENSION_PATH;
    this.log = options.log ?? ((m) => process.stderr.write(`[acp] ${m}\n`));
    // Path resolution: config.sessionMapPath -> env ACP_SESSION_MAP_PATH ->
    // ~/.acp-pi/sessions.json (locked A3 decision #1).
    this.sessionMap = new SessionMap(options.config?.sessionMapPath);
  }

  /** A3: load the on-disk session map once, then hand out the instance. */
  private async ensureMap(): Promise<SessionMap> {
    if (!this.mapLoaded) {
      await this.sessionMap.load();
      this.mapLoaded = true;
    }
    return this.sessionMap;
  }

  /** Tools gated on an ACP permission request (config, default bash,write,edit). */
  private gatedTools(): string[] {
    return this.config.gatedTools ?? [...DEFAULT_GATED_TOOLS];
  }

  /** Whether read is delegated to the ACP client (config, default true). */
  private fsDelegation(): boolean {
    return this.config.fsDelegation ?? DEFAULT_FS_DELEGATION;
  }

  /** Binds the connection handed in by AgentSideConnection. */
  attach(connection: AgentSideConnection): this {
    this.connection = connection;
    // Defer: toAgent is invoked inside the AgentSideConnection constructor,
    // before the SDK's internal connection (behind `closed`) is assigned.
    queueMicrotask(() => {
      void connection.closed.finally(() => this.shutdown());
    });
    return this;
  }

  /** Terminate all managed pi processes. */
  shutdown(): void {
    for (const [id, s] of this.sessions) {
      this.log(`closing session ${id}`);
      // Settle any in-flight turn (clears its watchdog timer, so shutdown
      // cannot keep the event loop alive).
      s.promptTurn?.reject(new Error("agent shutting down"));
      s.unsubscribeUi?.();
      s.rpc.close();
      this.sessions.delete(id);
    }
  }

  // ---------------------------------------------------------------------
  // ACP endpoints
  // ---------------------------------------------------------------------

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initialized = true;
    this.clientCapabilities = params.clientCapabilities;
    this.clientInfo = params.clientInfo ?? null;
    this.log(
      `initialize from ${params.clientInfo?.name ?? "<unknown client>"} ` +
        `(protocolVersion=${params.protocolVersion})`,
    );
    // A1/A2: no prompt/media, MCP, fs, or permission capability flags
    // exist on ACP 0.26.0 AgentCapabilities for those. A3: session
    // persistence IS implemented — advertise exactly the two persistence
    // capabilities (locked A3 decision #6) and nothing else.
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
      },
      agentInfo: {
        name: "pi-acp-adapter",
        title: "pi ACP Adapter",
        version: process.env.npm_package_version ?? "0.1.0",
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!this.initialized) {
      throw RequestError.invalidParams(undefined, "session/new before initialize");
    }
    let spawn: SpawnedSession;
    try {
      spawn = await this.spawnSession(params.cwd);
    } catch (err) {
      throw RequestError.internalError(undefined, `session/new failed: ${String(err)}`);
    }

    const sessionId = `pi-${randomUUID()}`;
    const session = this.registerSession(sessionId, params.cwd, spawn);

    // A3: after new_session succeeds and the thinking level is applied,
    // persist the session map entry from pi's get_state (data.sessionFile
    // absolute path + data.sessionId). Best effort: on failure the session
    // still works, it just can't be loaded later.
    try {
      const state = await spawn.thinking.getState();
      const piSessionId = typeof state.sessionId === "string" ? state.sessionId : null;
      const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : null;
      session.piSessionId = piSessionId;
      session.sessionFile = sessionFile;
      if (piSessionId && sessionFile) {
        await (await this.ensureMap()).put(sessionId, {
          piSessionId,
          sessionFile,
          cwd: params.cwd,
          thinkingLevel: spawn.thinkingLevel,
        });
      } else {
        this.log(
          `session ${sessionId}: get_state reported no sessionFile; ` +
            `skipping session-map persistence (cannot be loaded later)`,
        );
      }
    } catch (err) {
      this.log(
        `session ${sessionId}: get_state failed, skipping session-map ` +
          `persistence: ${String(err)}`,
      );
    }

    // Session info reports the available thinking levels as a select
    // config option (category "thought_level"), with the applied default
    // as the current value.
    //
    // B2: the runtime override is implemented via `session/set_config_option`
    // (thinking_level only). `session/set_mode` is still not implemented
    // (we advertise no modes).
    const configOptions = this.buildThinkingConfigOptions(
      spawn.availableLevels,
      spawn.thinkingLevel,
    );

    return {
      sessionId,
      modes: null, // session modes are not part of A1
      configOptions,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `unknown sessionId: ${params.sessionId}`,
      );
    }
    if (session.promptInFlight) {
      throw RequestError.internalError(
        undefined,
        `a prompt is already in flight for session ${params.sessionId}`,
      );
    }
    const text = extractPromptText(params.prompt);
    if (text.length === 0) {
      throw RequestError.invalidParams(
        undefined,
        "prompt contains no text content (A1 supports text prompts)",
      );
    }

    session.promptInFlight = true;
    session.cancelRequested = false;
    session.lastUsage = null;
    const unsubscribe = session.rpc.onEvent((ev) => this.handlePiEvent(session, ev));
    this.log(`prompt on session ${params.sessionId}: ${truncate(text)}`);
    return new Promise<{ stopReason: "end_turn" | "cancelled"; usage: Usage | null }>(
      (resolve, reject) => {
        let settled = false;
        // Settle exactly once: normally on pi's `agent_settled` event (turn
        // complete / aborted), on the watchdog if that never arrives, or
        // from the RPC rejection if pi REJECTED the prompt at acceptance
        // (success:false) — in that case there is no turn to stream.
        const settle = (stopReason: "end_turn" | "cancelled"): void => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          unsubscribe();
          session.cancelRequested = false;
          session.promptInFlight = false;
          session.promptTurn = null;
          resolve({ stopReason, usage: session.lastUsage });
        };
        // ACP contract: session/prompt resolves when the turn COMPLETES,
        // not when pi accepts it (real pi responds at acceptance; the turn
        // streams afterwards and the session file lands ~1s later). Safety
        // net so a lost `agent_settled` can never hang the request forever.
        const watchdog = setTimeout(
          () => {
            reject(
              new Error(
                "prompt turn did not settle (no agent_settled event); aborting",
              ),
            );
            session.cancelRequested = false;
            session.promptInFlight = false;
            session.promptTurn = null;
            unsubscribe();
            void session.rpc.request("abort").catch(() => {});
          },
          600000,
        );
        session.promptTurn = {
          resolve: (r) => settle(r.stopReason),
          reject: (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            unsubscribe();
            session.cancelRequested = false;
            session.promptInFlight = false;
            session.promptTurn = null;
            reject(e);
          },
        };
        // Fire-and-forget: a rejection here means pi rejected the prompt at
        // acceptance (no turn follows); `agent_settled` will NOT come for it.
        session.rpc
          .request("prompt", { message: text })
          .catch((err: unknown) => {
            const turn = session.promptTurn;
            if (turn === null || turn === undefined) {
              // Turn already settled (aborted): the abort's RPC rejection is
              // expected — ignore it.
              this.log(
                `prompt RPC settled after turn end for ${params.sessionId}: ${String(err)}`,
              );
              return;
            }
            turn.reject(new Error(`prompt failed: ${String(err)}`));
          });
      },
    );
  }

  // ---------------------------------------------------------------------
  // A3: session persistence — load / resume / cancel
  // ---------------------------------------------------------------------

  /**
   * ACP `session/load`: look up the session (in-memory map, else the
   * on-disk map), verify the persisted session file still exists, spawn a
   * fresh pi, `switch_session` onto it, re-apply the persisted thinking
   * level, register the session, and REPLAY the history as ACP session
   * updates BEFORE returning.
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.restoreSession(params, true);
  }

  /**
   * ACP `session/resume`: identical to loadSession EXCEPT no history replay
   * (no `get_messages`, no replay updates).
   */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.restoreSession(params, false);
  }

  /**
   * ACP `session/set_config_option` (ticket ACP-B2, ACP-CONFIG-002).
   *
   * We advertise exactly one config option (`thinking_level`, a select).
   * Setting it applies the level to the live pi session via the thinking
   * controller, updates the session record, and returns the COMPLETE
   * configOptions list (spec: the full set with current values, so the
   * client can reflect dependent changes). Unknown configId / unknown
   * session -> invalidParams (clean error, not a crash).
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    if (!this.initialized) {
      throw RequestError.invalidParams(undefined, "set_config_option before initialize");
    }
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(undefined, `unknown sessionId: ${params.sessionId}`);
    }
    // The only option we ever advertise is the thinking-level select.
    if (params.configId !== "thinking_level") {
      throw RequestError.invalidParams(
        undefined,
        `unknown configId: ${String(params.configId)}`,
      );
    }
    const value = params.value as ThinkingLevel;
    if (!session.availableLevels.includes(value)) {
      throw RequestError.invalidParams(
        undefined,
        `value ${String(value)} is not an available thinking level`,
      );
    }
    try {
      await session.thinking.set(value);
    } catch (err) {
      throw RequestError.internalError(
        undefined,
        `set_config_option (thinking_level) failed: ${String(err)}`,
      );
    }
    session.thinkingLevel = value;
    // Return the complete list with the refreshed current value (ACP-CONFIG-002).
    return {
      configOptions: this.buildThinkingConfigOptions(session.availableLevels, value),
    };
  }

  /**
   * Shared load/resume implementation (locked A3 decisions #3/#4).
   *
   * - Unknown session             -> RequestError.invalidParams (clean error)
   * - session file gone            -> delete the stale map entry (persisted)
   *                                   + RequestError.invalidParams; pi is NOT
   *                                   spawned until the file is confirmed
   * - switch_session cancelled/fail -> child closed + internalError
   */
  private async restoreSession(
    params: {
      sessionId: string;
      cwd: string;
      mcpServers?: Array<McpServer>;
      additionalDirectories?: string[];
    },
    replay: boolean,
  ): Promise<{ modes: null; configOptions: SessionConfigOption[] }> {
    if (!this.initialized) {
      throw RequestError.invalidParams(
        undefined,
        `session/${replay ? "load" : "resume"} before initialize`,
      );
    }
    // MCP wiring is out of scope for A3: accept and ignore (log only).
    if (params.mcpServers && params.mcpServers.length > 0) {
      this.log(
        `session/${replay ? "load" : "resume"}: ignoring ` +
          `${params.mcpServers.length} mcpServers (MCP wiring is out of scope)`,
      );
    }

    // B2 fast path: a session that is live in memory but has no on-disk file
    // yet (created but never prompted — pi writes the session file on the
    // first prompt) cannot be re-spawned from disk. Reuse the live session
    // as the source of truth instead of failing "session file missing".
    // When the file DOES exist (a persisted session), the normal
    // re-spawn/switch_session path below still runs (ACP-LOAD replay).
    const live = this.sessions.get(params.sessionId);
    if (live) {
      let fileOnDisk = false;
      if (live.sessionFile) {
        try {
          await access(live.sessionFile);
          fileOnDisk = true;
        } catch {
          fileOnDisk = false;
        }
      }
      if (!fileOnDisk) {
        this.log(
          `session/${replay ? "load" : "resume"} for live in-memory session ` +
            `${params.sessionId} (no on-disk file yet); reusing live session`,
        );
        if (replay) {
          try {
            await this.replayHistory(live);
          } catch (err) {
            throw RequestError.internalError(
              undefined,
              `session/load replay failed: ${String(err)}`,
            );
          }
        }
        return {
          modes: null,
          configOptions: this.buildThinkingConfigOptions(
            live.availableLevels,
            live.thinkingLevel,
          ),
        };
      }
    }

    const map = await this.ensureMap();
    const entry = this.findSessionEntry(params.sessionId) ?? map.get(params.sessionId);
    if (!entry) {
      throw RequestError.invalidParams(
        undefined,
        `unknown sessionId: ${params.sessionId}`,
      );
    }

    // Confirm the persisted session file exists BEFORE spawning pi (no
    // orphan process for a stale entry).
    try {
      await access(entry.sessionFile);
    } catch {
      this.log(
        `session ${params.sessionId}: session file missing ` +
          `(${entry.sessionFile}); removing stale map entry`,
      );
      await map.remove(params.sessionId);
      throw RequestError.invalidParams(
        undefined,
        `session file missing: ${entry.sessionFile}`,
      );
    }

    // If this ACP session is already in memory, close it first so the
    // re-spawn does not leave an orphan pi child behind.
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      existing.unsubscribeUi?.();
      existing.rpc.close();
      this.sessions.delete(params.sessionId);
    }

    let spawn: SpawnedSession;
    try {
      spawn = await this.spawnSession(entry.cwd, {
        resumeFrom: {
          sessionFile: entry.sessionFile,
          thinkingLevel: entry.thinkingLevel,
        },
      });
    } catch (err) {
      // spawnSession has already closed the child.
      throw RequestError.internalError(
        undefined,
        `session/${replay ? "load" : "resume"} failed: ${String(err)}`,
      );
    }

    const session = this.registerSession(params.sessionId, entry.cwd, spawn);
    session.piSessionId = entry.piSessionId;
    session.sessionFile = entry.sessionFile;
    session.lastUsedAt = new Date().toISOString();
    // Refresh the on-disk entry's lastUsedAt (atomic persist).
    await map.touch(params.sessionId);

    if (replay) {
      try {
        // Replay MUST complete before loadSession returns to the client.
        await this.replayHistory(session);
      } catch (err) {
        session.unsubscribeUi?.();
        session.rpc.close();
        this.sessions.delete(params.sessionId);
        throw RequestError.internalError(
          undefined,
          `session/load failed during history replay: ${String(err)}`,
        );
      }
    }

    this.log(
      `session ${params.sessionId}: ${replay ? "loaded" : "resumed"} ` +
        `(sessionFile=${entry.sessionFile}, piSessionId=${entry.piSessionId})`,
    );
    return {
      modes: null, // session modes are not part of A3
      configOptions: this.buildThinkingConfigOptions(
        spawn.availableLevels,
        spawn.thinkingLevel,
      ),
    };
  }

  /**
   * `session/cancel` (replaces the A1/A2 stub) — clean, no orphans
   * (locked A3 decision #5):
   *   - known session, prompt in flight: set `cancelRequested` and send pi
   *     `abort`; the in-flight `prompt()` observes the flag and returns
   *     `{ stopReason: "cancelled", usage }`
   *   - known session, no prompt in flight: no-op
   *   - unknown session: log a warning and RESOLVE. `session/cancel` is an
   *     ACP notification — throwing would produce an invalid JSON-RPC error
   *     response to a notification. No throw, no orphan, no map mutation.
   * Cancel never kills the pi child: the session stays usable for the
   * next prompt.
   */
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.log(
        `cancel for unknown session ${params.sessionId} (notification; ` +
          `ignored — no such session)`,
      );
      return;
    }
    if (!session.promptInFlight) {
      // No run to cancel: resolve silently.
      return;
    }
    session.cancelRequested = true;
    this.log(`session ${params.sessionId}: cancel requested, sending pi abort`);
    void session.rpc.request("abort").catch((err) =>
      this.log(`abort failed for session ${params.sessionId}: ${String(err)}`),
    );
  }

  // ---------------------------------------------------------------------
  // pi-RPC-side thinking controls (adapter methods, unit-testable)
  // ---------------------------------------------------------------------

  getAvailableThinkingLevels(sessionId: string): Promise<ThinkingLevel[]> {
    return this.requireSession(sessionId).thinking.getAvailableLevels();
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
    const s = this.requireSession(sessionId);
    return s.thinking.set(level).then(() => {
      s.thinkingLevel = level;
    });
  }

  cycleThinkingLevel(sessionId: string): Promise<ThinkingLevel> {
    const s = this.requireSession(sessionId);
    return s.thinking.cycle().then((level) => {
      s.thinkingLevel = level;
      return level;
    });
  }

  getSessionState(sessionId: string): Promise<Record<string, unknown>> {
    return this.requireSession(sessionId).thinking.getState();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Spawn a fresh `pi --mode rpc` exactly like `newSession` does (same
   * extension + env) and wire it: `new_session`, optional `switch_session`
   * (load/resume), and thinking-level application. Closes the child and
   * rethrows on any failure.
   */
  private async spawnSession(
    cwd: string,
    opts: { resumeFrom?: { sessionFile: string; thinkingLevel: string } } = {},
  ): Promise<SpawnedSession> {
    const rpc = new PiRpc({
      spawner: this.spawner,
      cwd,
      log: this.log,
      // Load the bundled extension (permission gate + read override) and
      // tell it which tools to gate / whether read is delegated to the client.
      extensionPath: this.extensionPath,
      env: {
        ACP_FS_DELEGATION: this.fsDelegation() ? "1" : "0",
        ACP_GATED_TOOLS: this.gatedTools().join(","),
      },
    });
    rpc.start();
    try {
      await rpc.request("new_session", { cwd });
      const thinking = new ThinkingController(rpc);
      const availableLevels = await thinking.getAvailableLevels();

      if (opts.resumeFrom) {
        // pi 0.85.1: switch_session -> { success, data: { cancelled } };
        // PiRpc already rejects on success === false.
        const data = (await rpc.request("switch_session", {
          sessionPath: opts.resumeFrom.sessionFile,
        })) as Record<string, unknown> | undefined;
        const d = data && typeof data === "object" ? data : {};
        if (d.cancelled === true) {
          throw new Error("switch_session was cancelled by an extension");
        }
      }

      const thinkingLevel = opts.resumeFrom
        ? await this.applyPersistedThinkingLevel(
            thinking,
            availableLevels,
            opts.resumeFrom.thinkingLevel,
          )
        : await this.applyDefaultThinkingLevel(rpc, availableLevels);

      return { rpc, thinking, availableLevels, thinkingLevel };
    } catch (err) {
      rpc.close();
      throw err;
    }
  }

  /**
   * Build the ManagedSession for a freshly spawned pi, bridge the bundled
   * extension's UI dialogs to the ACP client, and register it in the
   * in-memory sessions map (same shape + bridging as newSession).
   */
  private registerSession(
    sessionId: string,
    cwd: string,
    spawn: SpawnedSession,
  ): ManagedSession {
    const now = new Date().toISOString();
    const session: ManagedSession = {
      rpc: spawn.rpc,
      thinking: spawn.thinking,
      cwd,
      availableLevels: spawn.availableLevels,
      thinkingLevel: spawn.thinkingLevel,
      promptInFlight: false,
      cancelRequested: false,
      lastUsage: null,
      promptTurn: null,
      piSessionId: null,
      sessionFile: null,
      createdAt: now,
      lastUsedAt: now,
    };
    // Bridge the bundled extension's UI dialogs to the ACP client:
    //   select `[acp:perm] ...`  -> session/request_permission
    //   input  `[acp:read] ...`  -> fs/read_text_file
    session.unsubscribeUi = spawn.rpc.onExtensionUiRequest((req) => {
      void this.handleExtensionUiRequest(session, req).catch((err) =>
        this.log(`extension_ui handling failed: ${String(err)}`),
      );
    });
    this.sessions.set(sessionId, session);
    this.log(
      `session ${sessionId}: thinking levels=[${spawn.availableLevels.join(",")}] ` +
        `level=${spawn.thinkingLevel}`,
    );
    return session;
  }

  /**
   * The thinking_level select config option (category "thought_level")
   * reported in session/new and session/load|resume responses.
   */
  private buildThinkingConfigOptions(
    availableLevels: ThinkingLevel[],
    applied: ThinkingLevel,
  ): SessionConfigOption[] {
    const configOptions: SessionConfigOption[] = [];
    if (availableLevels.length > 0) {
      configOptions.push({
        id: "thinking_level",
        name: "Thinking level",
        description: "Model reasoning effort for this session (pi thinking level).",
        category: "thought_level",
        type: "select",
        currentValue: applied,
        options: availableLevels.map((l) => ({ value: l, name: l })),
      });
    }
    return configOptions;
  }

  /**
   * Re-apply a persisted thinking level on a freshly switched pi session:
   * compare against `get_state().thinkingLevel` and set only when different.
   */
  private async applyPersistedThinkingLevel(
    thinking: ThinkingController,
    availableLevels: ThinkingLevel[],
    persisted: string,
  ): Promise<ThinkingLevel> {
    const state = await thinking.getState();
    const current =
      typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
    if (current === persisted) {
      return persisted as ThinkingLevel;
    }
    if (!availableLevels.includes(persisted as ThinkingLevel)) {
      this.log(
        `persisted thinking level '${persisted}' is not available on this ` +
          `model (available: [${availableLevels.join(",")}]); keeping ` +
          `pi's current level '${current ?? "<default>"}'`,
      );
      return (current ?? DEFAULT_THINKING_LEVEL) as ThinkingLevel;
    }
    await thinking.set(persisted as ThinkingLevel);
    return persisted as ThinkingLevel;
  }

  /**
   * In-memory view of the session map: a ManagedSession that already knows
   * its pi session id + file is equivalent to a disk entry, so a load in
   * the same adapter process does not need to read the file.
   */
  private findSessionEntry(sessionId: string): SessionMapEntry | undefined {
    const s = this.sessions.get(sessionId);
    if (!s || !s.sessionFile || !s.piSessionId) return undefined;
    return {
      piSessionId: s.piSessionId,
      sessionFile: s.sessionFile,
      cwd: s.cwd,
      thinkingLevel: s.thinkingLevel,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    };
  }

  /**
   * Replay pi's stored history to the ACP client as session updates
   * (session/load only). pi 0.85.1 `get_messages` -> `data.messages[]`
   * with `role` ("user"|"assistant") and `content` (string or blocks).
   * MUST complete before loadSession returns to the client.
   */
  private async replayHistory(session: ManagedSession): Promise<void> {
    const data = (await session.rpc.request("get_messages")) as {
      messages?: unknown;
    } | undefined;
    const messages =
      data && typeof data === "object" && Array.isArray((data as { messages?: unknown[] }).messages)
        ? ((data as { messages: unknown[] }).messages)
        : [];
    for (const message of messages) {
      for (const update of historyMessageToAcpUpdates(message)) {
        await this.sendUpdate(session, update);
      }
    }
    this.log(`replayed ${messages.length} history message(s)`);
  }

  private requireSession(sessionId: string): ManagedSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown sessionId: ${sessionId}`);
    return s;
  }

  /**
   * Apply the configured default thinking level. `medium` is the default
   * where tiers exist: if the model's available list contains the configured
   * level, use it; otherwise fall back to `medium` if available, else the
   * first available tier; otherwise leave pi at whatever its own default is.
   */
  private async applyDefaultThinkingLevel(
    rpc: PiRpc,
    availableLevels: ThinkingLevel[],
  ): Promise<ThinkingLevel> {
    if (availableLevels.length === 0) return DEFAULT_THINKING_LEVEL;
    const desired = availableLevels.includes(this.config.thinkingLevel)
      ? this.config.thinkingLevel
      : availableLevels.includes(DEFAULT_THINKING_LEVEL)
        ? DEFAULT_THINKING_LEVEL
        : availableLevels[0];
    const controller = new ThinkingController(rpc);
    const state = await controller.getState();
    const current = typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
    if (current !== desired) {
      await controller.set(desired);
    }
    return desired;
  }

  /**
   * Map pi session events onto ACP session/update notifications.
   *
   * Verified pi 0.85.x event order for a run:
   *   session -> agent_start -> turn_start -> message_start ->
   *   message_update (xN) -> message_end -> turn_end -> agent_end ->
   *   agent_settled
   *
   * `message_update` deltas: `text` -> agent_message_chunk,
   * `thinking` -> agent_thought_chunk. `agent_end.messages[]` carries the
   * final assistant message and its `usage` (token counts).
   */
  private handlePiEvent(session: ManagedSession, ev: PiRecord): void {
    if (this.connection === null) return;
    switch (ev.type) {
      case "message_update":
        for (const block of extractDeltaBlocks(ev)) {
          const update: SessionUpdate | null =
            block.type === "text" && typeof block.text === "string"
              ? {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: block.text },
                }
              : block.type === "thinking" && typeof block.text === "string"
                ? {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: block.text },
                  }
                : null;
          // A1 maps text/thinking only; toolCall blocks are A2.
          if (update) {
            void this.sendUpdate(session, update);
          }
        }
        break;
      case "agent_end": {
        const usage = extractAgentEndUsage(ev);
        if (usage) session.lastUsage = usage;
        break;
      }
      case "agent_settled": {
        // B2: the turn is over (completed or aborted). Resolve the in-flight
        // ACP session/prompt now — this is the ACP turn-completion signal.
        // (agent_settled {aborted:true} also arrives for a session/cancel.)
        const turn = session.promptTurn;
        if (turn) {
          const aborted = ev.aborted === true || session.cancelRequested;
          turn.resolve({
            stopReason: aborted ? "cancelled" : "end_turn",
            usage: session.lastUsage,
          });
        }
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const toolCallId = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
        const toolName = typeof ev.toolName === "string" ? ev.toolName : "";
        const args =
          ev.args && typeof ev.args === "object"
            ? (ev.args as Record<string, unknown>)
            : {};
        const update = piToolEventToAcpUpdate(ev, toolCallId, toolName, args, session.cwd);
        if (update) {
          void this.sendUpdate(session, update);
        }
        break;
      }
      default:
    }
  }

  private sessionIdFor(session: ManagedSession): string {
    for (const [id, s] of this.sessions) {
      if (s === session) return id;
    }
    throw new Error("session not found");
  }

  /**
   * Handle an `extension_ui_request` from the bundled pi extension:
   *   - select, title `[acp:perm] <tool> [id:<toolCallId>] <summary>`:
   *     run the ACP permission round-trip (pending tool_call update +
   *     session/request_permission with allow_once/reject_once) and write
   *     the selected option id back to pi. Any failure rejects (blocks).
   *   - input, title `[acp:read] <absolutePath>`:
   *     delegate to the ACP client via fs/read_text_file; write the content
   *     back, or `cancelled: true` when the client doesn't support it.
   *   - anything else: cancel so the extension can proceed.
   */
  private async handleExtensionUiRequest(
    session: ManagedSession,
    req: PiRecord,
  ): Promise<void> {
    const rpc = session.rpc;
    const id = String(req.id ?? "");
    const method = typeof req.method === "string" ? req.method : "";
    const title = typeof req.title === "string" ? req.title : "";

    if (method === "select" && title.startsWith("[acp:perm] ")) {
      const parsed = parsePermTitle(title);
      if (!parsed || this.connection === null) {
        rpc.writeExtensionUiResponse(id, undefined, undefined, true);
        return;
      }
      let outcome: PermissionOutcome = "reject";
      try {
        outcome = await requestToolPermission({
          connection: this.connection,
          sessionId: this.sessionIdFor(session),
          toolCallId: parsed.toolCallId,
          toolName: parsed.toolName,
          argsSummary: parsed.argsSummary,
        });
      } catch (err) {
        this.log(
          `permission request failed for ${parsed.toolName} ` +
            `(${parsed.toolCallId}): ${String(err)}`);
        outcome = "reject";
      }
      rpc.writeExtensionUiResponse(
        id,
        outcome === "allow" ? "allow_once" : "reject_once",
      );
      return;
    }

    if (method === "input" && title.startsWith(READ_TITLE_PREFIX)) {
      const filePath = title.slice(READ_TITLE_PREFIX.length).trim();
      let content: string | null = null;
      if (this.connection !== null) {
        try {
          content = await handleReadDelegation(
            this.sessionIdFor(session),
            filePath,
            this.connection,
            this.clientCapabilities,
          );
        } catch (err) {
          this.log(`read delegation failed for ${filePath}: ${String(err)}`);
        }
      }
      if (content === null) {
        rpc.writeExtensionUiResponse(id, undefined, undefined, true);
      } else {
        rpc.writeExtensionUiResponse(id, content);
      }
      return;
    }

    // Unrecognized dialog: cancel it.
    rpc.writeExtensionUiResponse(id, undefined, undefined, true);
  }

  private async sendUpdate(session: ManagedSession, update: SessionUpdate): Promise<void> {
    if (this.connection === null) return;
    await this.connection.sessionUpdate({
      sessionId: this.sessionIdFor(session),
      update,
    });
  }

  // -----------------------------------------------------------------------
  // Required Agent-interface methods OUT of scope.
  // Kept as explicit stubs (never advertised via capabilities).
  // -----------------------------------------------------------------------

  /**
   * A1: authentication is not part of the ticket; no auth methods are
   * advertised in initialize, so a conforming client will not call this.
   */
  async authenticate(_params: AuthenticateRequest): Promise<never> {
    throw RequestError.methodNotFound("authenticate");
  }
}

/**
 * Pull pi streaming delta blocks out of a `message_update` record.
 * Tolerates `delta` (object or array) and `content` (array of blocks).
 */
function extractDeltaBlocks(ev: PiRecord): Array<{ type?: unknown; text?: unknown }> {
  const out: Array<{ type?: unknown; text?: unknown }> = [];
  const delta = ev.delta;
  if (Array.isArray(delta)) out.push(...(delta as Array<Record<string, unknown>>));
  else if (delta && typeof delta === "object") out.push(delta as Record<string, unknown>);
  if (Array.isArray(ev.content)) out.push(...(ev.content as Array<Record<string, unknown>>));
  return out.filter(
    (b): b is { type?: unknown; text?: unknown } => b && typeof b === "object",
  );
}

/** Extract the final assistant message usage from an `agent_end` record. */
function extractAgentEndUsage(ev: PiRecord): Usage | null {
  const messages = ev.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; usage?: unknown };
    if (m.role !== "assistant") continue;
    const u = m.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== "object") return null;
    return toAcpUsage(u);
  }
  return null;
}

/**
 * Map a pi usage object onto the ACP (unstable) Usage type, tolerating
 * camelCase / snake_case / bare token-count spellings.
 */
function toAcpUsage(u: Record<string, unknown>): Usage {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = num(u.inputTokens ?? u.input ?? u.input_tokens);
  const output = num(u.outputTokens ?? u.output ?? u.output_tokens);
  const thought = num(u.thoughtTokens ?? u.thought ?? u.thought_tokens ?? u.reasoning);
  const total = num(u.totalTokens ?? u.total ?? u.total_tokens) || input + output;
  return {
    totalTokens: total,
    inputTokens: input,
    outputTokens: output,
    thoughtTokens: thought || null,
  };
}

/** Join all text content blocks of an ACP prompt into one string. */
function extractPromptText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Map one pi history message (a `get_messages` AgentMessage) to the ACP
 * session/update notifications used for session/load replay (locked A3
 * mapping):
 *   role user      -> user_message_chunk (text content)
 *   role assistant -> agent_message_chunk   for `text` blocks
 *                     agent_thought_chunk   for `thinking` blocks
 *                     tool_call             for `toolCall` blocks: a SINGLE
 *                     update, `title: "<toolName>: <args JSON truncated to
 *                     80 chars>"`, kind via toolNameToKind (same mapping as
 *                     live tool events), `status: "completed"`, rawInput
 *                     = the block's arguments, toolCallId = the block's id
 *                     (or a generated uuid when absent).
 * Unknown roles/block types produce no updates.
 */
function historyMessageToAcpUpdates(message: unknown): SessionUpdate[] {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (!m || typeof m !== "object") return [];
  const role = typeof m.role === "string" ? m.role : null;
  if (role !== "user" && role !== "assistant") return [];

  const blocks: unknown[] = Array.isArray(m.content)
    ? m.content
    : typeof m.content === "string"
      ? m.content.length > 0
        ? [{ type: "text", text: m.content }]
        : []
      : [];

  const updates: SessionUpdate[] = [];
  for (const raw of blocks) {
    const block = raw as Record<string, unknown> | null;
    if (!block || typeof block !== "object") continue;
    const type = typeof block.type === "string" ? block.type : null;
    if (type === "text" && typeof block.text === "string") {
      updates.push(
        role === "user"
          ? {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: block.text },
            }
          : {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: block.text },
            },
      );
    } else if (
      type === "thinking" &&
      role === "assistant" &&
      typeof block.text === "string"
    ) {
      updates.push({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: block.text },
      });
    } else if (type === "toolCall" && role === "assistant") {
      const name =
        typeof block.name === "string"
          ? block.name
          : typeof block.toolName === "string"
            ? block.toolName
            : "";
      const args =
        block.arguments && typeof block.arguments === "object"
          ? (block.arguments as Record<string, unknown>)
          : {};
      const argJson = JSON.stringify(args);
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: typeof block.id === "string" ? block.id : randomUUID(),
        title: `${name}: ${argJson.length > 80 ? argJson.slice(0, 80) : argJson}`,
        kind: toolNameToKind(name),
        status: "completed",
        rawInput: args,
      });
    }
  }
  return updates;
}

function truncate(s: string, n = 80): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

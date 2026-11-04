import { randomUUID } from "node:crypto";
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
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type Usage,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_THINKING_LEVEL,
  type AcpConfig,
  type ThinkingLevel,
} from "./config.js";
import { PiRpc, type PiRecord, type PiSpawner } from "./pi-rpc.js";
import { ThinkingController } from "./thinking.js";

export interface AcpAgentOptions {
  config?: AcpConfig;
  /** Spawner seam for the pi subprocess (tests inject an in-process fake). */
  spawner?: PiSpawner;
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
  /** Usage reported by the last agent_end for the in-flight prompt. */
  lastUsage: Usage | null;
}

/**
 * ACP agent backed by a `pi --mode rpc` subprocess (ticket ACP-A1).
 *
 * A1 scope:
 *   - `initialize`      — handshake + capability exchange
 *   - `session/new`     — spawn pi, report available thinking levels, apply
 *                         the configured default thinking level
 *   - `session/prompt`  — stream pi's run back as ACP session updates
 *   - pi-RPC-side thinking controls (set / get_available / cycle / get_state)
 *
 * NOT in A1 (deferred, do not advertise):
 *   - tool-call mapping + `session/request_permission` + `fs/read_text_file`
 *     (ticket A2)
 *   - `session/load`, `session/cancel`, `session/resume` persistence
 *     (ticket A3)
 *   - ACP runtime `session/set_mode` / `session/set_config_option` override of
 *     the thinking level (deferred; A1 applies the level from config only,
 *     plus the pi-RPC-side controls exposed on this adapter).
 */
export class PiAcpAgent implements Agent {
  private readonly config: AcpConfig;
  private readonly spawner?: PiSpawner;
  private readonly log: (message: string) => void;
  private connection: AgentSideConnection | null = null;
  private readonly sessions = new Map<string, ManagedSession>();
  /** Client capabilities captured during initialize. */
  clientCapabilities: InitializeRequest["clientCapabilities"] = undefined;
  /** Client implementation info captured during initialize. */
  clientInfo: InitializeRequest["clientInfo"] = undefined;
  private initialized = false;

  constructor(options: AcpAgentOptions = {}) {
    this.config = options.config ?? { thinkingLevel: DEFAULT_THINKING_LEVEL };
    this.spawner = options.spawner;
    this.log = options.log ?? ((m) => process.stderr.write(`[acp] ${m}\n`));
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
    // Report only what A1 actually implements.
    // PLANNED (A2, deliberately NOT advertised yet): tool-call mapping,
    // session/request_permission, fs.readTextFile.
    // PLANNED (A3, deliberately NOT advertised yet): loadSession, resume.
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        // A1: no loadSession, no prompt/media extras, no MCP, no fs, no
        // permission plumbing — text prompts in, text+thought chunks out.
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
    const rpc = new PiRpc({
      spawner: this.spawner,
      cwd: params.cwd,
      log: this.log,
    });
    rpc.start();

    try {
      await rpc.request("new_session", { cwd: params.cwd });
      const availableLevels = await new ThinkingController(rpc).getAvailableLevels();
      const applied = await this.applyDefaultThinkingLevel(rpc, availableLevels);

      const sessionId = `pi-${randomUUID()}`;
      this.sessions.set(sessionId, {
        rpc,
        thinking: new ThinkingController(rpc),
        cwd: params.cwd,
        availableLevels,
        thinkingLevel: applied,
        promptInFlight: false,
        lastUsage: null,
      });
      this.log(
        `session ${sessionId}: thinking levels=[${availableLevels.join(",")}] ` +
          `level=${applied}`,
      );

      // Session info reports the available thinking levels as a select
      // config option (category "thought_level"), with the applied default
      // as the current value.
      //
      // NOTE: the ACP runtime override (`session/set_mode` /
      // `session/set_config_option`) is DEFERRED — we intentionally do not
      // implement those endpoints in A1, so a client selecting a new value
      // there is out of contract until the follow-up ticket.
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

      return {
        sessionId,
        modes: null, // session modes are not part of A1
        configOptions,
      };
    } catch (err) {
      rpc.close();
      throw RequestError.internalError(undefined, `session/new failed: ${String(err)}`);
    }
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
    session.lastUsage = null;
    const unsubscribe = session.rpc.onEvent((ev) => this.handlePiEvent(session, ev));
    this.log(`prompt on session ${params.sessionId}: ${truncate(text)}`);
    try {
      // The correlated response completes when pi finishes the turn; the
      // streamed content itself arrives via the event stream (message_update
      // deltas) and agent_end (final messages + usage).
      await session.rpc.request("prompt", { text });
      return { stopReason: "end_turn", usage: session.lastUsage };
    } catch (err) {
      throw RequestError.internalError(undefined, `prompt failed: ${String(err)}`);
    } finally {
      unsubscribe();
      session.promptInFlight = false;
    }
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
      default:
        // session / agent_start / turn_start / message_start / message_end /
        // turn_end / agent_settled: no ACP-side mapping needed in A1.
        break;
    }
  }

  private sessionIdFor(session: ManagedSession): string {
    for (const [id, s] of this.sessions) {
      if (s === session) return id;
    }
    throw new Error("session not found");
  }

  private async sendUpdate(session: ManagedSession, update: SessionUpdate): Promise<void> {
    if (this.connection === null) return;
    await this.connection.sessionUpdate({
      sessionId: this.sessionIdFor(session),
      update,
    });
  }

  // -----------------------------------------------------------------------
  // Required Agent-interface methods OUT of A1 scope.
  // Kept as explicit stubs (never advertised via capabilities).
  // -----------------------------------------------------------------------

  /**
   * A1: authentication is not part of the ticket; no auth methods are
   * advertised in initialize, so a conforming client will not call this.
   */
  async authenticate(_params: AuthenticateRequest): Promise<never> {
    throw RequestError.methodNotFound("authenticate");
  }

  /**
   * A1: full `session/cancel` handling is ticket A3. Best effort only: ask
   * pi to abort the current run if a session exists.
   */
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      void session.rpc.request("abort").catch(() => undefined);
    }
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

function truncate(s: string, n = 80): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

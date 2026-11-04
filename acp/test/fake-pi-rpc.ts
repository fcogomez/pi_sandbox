import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { PiProcessLike } from "../src/pi-rpc.js";

/**
 * An in-process FAKE pi that speaks the exact `pi --mode rpc` JSONL wire
 * protocol (pi 0.85.x shapes):
 *
 *   stdin:  {"id":"req-N","type":"<command>",...args}   (one object per LF line)
 *   stdout: responses  {"id":"req-N","type":"response","command","success",...}
 *            events    {"type":"<event>",...}           (no id)
 *
 * NO real pi binary, NO LLM, NO vLLM, NO network — fully offline.
 *
 * On `prompt` (behavior "text-only", the A1 default) it emits the verified
 * event order:
 *   session -> agent_start -> turn_start -> message_start ->
 *   message_update (xN) -> message_end -> turn_end -> agent_end -> agent_settled
 * and only then answers the correlated prompt command.
 *
 * A2 behaviors (promptBehavior):
 *   "with-tool"      — also emits tool_execution_start/update/end
 *   "with-permission"— for gated tools, emits an extension_ui_request
 *                      (select, `[acp:perm] ...`) BEFORE tool_execution_start
 *                      and waits for the extension_ui_response; reject_once
 *                      -> tool_execution_end with isError, "User denied"
 *   "with-read"      — tool_execution_start (read) then an
 *                      extension_ui_request (input, `[acp:read] <path>`);
 *                      the response value becomes the tool result, a
 *                      cancelled response simulates the local fallback.
 *
 * The fake simulates the bundled pi extension's behavior directly (it does
 * NOT load pi-extension.ts); `gatedTools` / `fsDelegation` mirror the
 * ACP_GATED_TOOLS / ACP_FS_DELEGATION env vars the adapter sets at spawn.
 */
export type FakePromptBehavior =
  | "text-only"
  | "with-tool"
  | "with-permission"
  | "with-read";

export interface FakeToolSpec {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  /** Text of the tool_execution_update partialResult. */
  partialText?: string;
  /** Text of the tool_execution_end result. */
  resultText?: string;
  isError?: boolean;
}

export interface FakePiOptions {
  /** Levels the fake model supports (default: a 4-tier set). */
  availableLevels?: string[];
  /** Initial thinking level before any set_thinking_level. */
  initialLevel?: string;
  /** Canned thinking deltas streamed as message_update (type "thinking"). */
  thinkingDeltas?: string[];
  /** Canned text deltas streamed as message_update (type "text"). */
  textDeltas?: string[];
  /** Usage reported on the final assistant message in agent_end. */
  usage?: { input: number; output: number; thought?: number };
  /** Prompt behavior (A2; default "text-only" = A1 behavior). */
  promptBehavior?: FakePromptBehavior;
  /** Tool used by "with-tool" / "with-permission" (default: bash ls -la). */
  tool?: FakeToolSpec;
  /** Mirrors ACP_GATED_TOOLS (default bash,write,edit). */
  gatedTools?: string[];
  /** Mirrors ACP_FS_DELEGATION (default true). */
  fsDelegation?: boolean;
  /** Path the simulated read tool requests ("with-read"). */
  readPath?: string;
  /** Content the simulated local fallback returns ("with-read"). */
  readFallbackText?: string;
}

export class FakePi implements PiProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = -1;

  /** Every command record received, in order (for test assertions). */
  readonly commands: Array<Record<string, unknown>> = [];

  /** Every `extension_ui_response` record received, in order. */
  readonly uiResponses: Array<Record<string, unknown>> = [];

  private readonly emitter = new EventEmitter();
  private availableLevels: string[];
  private level: string;
  private readonly thinkingDeltas: string[];
  private readonly textDeltas: string[];
  private readonly usage: { input: number; output: number; thought?: number };
  private readonly behavior: FakePromptBehavior;
  private readonly toolSpec: FakeToolSpec;
  private readonly gatedTools: string[];
  private readonly fsDelegation: boolean;
  private readonly readPath: string;
  private readonly readFallbackText: string;
  private sessionId = "fake-pi-session-1";
  private lineBuffer = "";
  private extUiSeq = 0;
  private readonly extUiPending = new Map<
    string,
    (response: Record<string, unknown>) => void
  >();

  constructor(options: FakePiOptions = {}) {
    this.availableLevels = options.availableLevels ?? ["off", "low", "medium", "high"];
    this.level =
      options.initialLevel ?? (this.availableLevels.includes("medium") ? "medium" : this.availableLevels[0]);
    this.thinkingDeltas = options.thinkingDeltas ?? ["Let me think…", " …done thinking."];
    this.textDeltas = options.textDeltas ?? ["Hello", " world"];
    this.usage = options.usage ?? { input: 11, output: 22, thought: 3 };
    this.behavior = options.promptBehavior ?? "text-only";
    this.toolSpec = options.tool ?? {};
    this.gatedTools = options.gatedTools ?? ["bash", "write", "edit"];
    this.fsDelegation = options.fsDelegation ?? true;
    this.readPath = options.readPath ?? "/tmp/delegated.txt";
    this.readFallbackText = options.readFallbackText ?? "local fallback content";

    this.stdin.on("data", (chunk: Buffer) => this.ingest(chunk.toString("utf8")));
    this.stdin.on("end", () => this.ingest("\n"));
  }

  // -- PiProcessLike -------------------------------------------------------

  on(
    event: string,
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((err: Error) => void)
      | ((...args: unknown[]) => void),
  ): unknown {
    return this.emitter.on(event, listener);
  }

  kill(): boolean {
    this.emitter.emit("exit", 0, null);
    this.stdout.end();
    this.stdin.end();
    return true;
  }

  // -- wire protocol -------------------------------------------------------

  private ingest(text: string): void {
    this.lineBuffer += text;
    for (;;) {
      const idx = this.lineBuffer.indexOf("\n");
      if (idx === -1) return;
      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (line.trim() === "") continue;
      void this.handle(JSON.parse(line) as Record<string, unknown>);
    }
  }

  private async handle(cmd: Record<string, unknown>): Promise<void> {
    const id = cmd.id as string | number | undefined;
    const type = String(cmd.type ?? "");

    // Extension UI responses unblock a pending simulated dialog; they are
    // not pi commands.
    if (type === "extension_ui_response") {
      this.uiResponses.push(cmd);
      const resolver = id !== undefined ? this.extUiPending.get(String(id)) : undefined;
      if (resolver) {
        this.extUiPending.delete(String(id));
        resolver(cmd);
      }
      return;
    }

    this.commands.push(cmd);

    switch (type) {
      case "new_session":
        this.respond(id, type, true, {
          sessionId: this.sessionId,
          model: "fake/model-x",
          thinkingLevel: this.level,
        });
        return;

      case "get_state":
        this.respond(id, type, true, {
          sessionId: this.sessionId,
          model: "fake/model-x",
          thinkingLevel: this.level,
          messageCount: 0,
        });
        return;

      case "get_available_thinking_levels":
        this.respond(id, type, true, { levels: [...this.availableLevels] });
        return;

      case "set_thinking_level": {
        const level = cmd.level;
        if (typeof level !== "string" || !this.availableLevels.includes(level)) {
          this.respond(id, type, false, undefined, `unsupported level: ${String(level)}`);
          return;
        }
        this.level = level;
        this.respond(id, type, true, { thinkingLevel: this.level });
        return;
      }

      case "cycle_thinking_level": {
        const i = this.availableLevels.indexOf(this.level);
        this.level = this.availableLevels[(i + 1) % this.availableLevels.length];
        this.respond(id, type, true, { thinkingLevel: this.level });
        return;
      }

      case "prompt":
        await this.runPrompt(id, String(cmd.text ?? ""));
        return;

      case "abort":
        this.respond(id, type, true, { aborted: true });
        return;

      default:
        this.respond(id, type, false, undefined, `unknown command: ${type}`);
    }
  }

  /** Emit the full verified event stream, then answer the prompt command. */
  private async runPrompt(id: string | number | undefined, text: string): Promise<void> {
    const messageId = "fake-msg-1";
    const head: Array<Record<string, unknown>> = [
      { type: "session", sessionId: this.sessionId },
      { type: "agent_start" },
      { type: "turn_start", turn: 0 },
      { type: "message_start", messageId, role: "assistant" },
    ];
    // Verified pi order: thinking deltas precede text deltas within the run.
    const preText: Array<Record<string, unknown>> =
      this.behavior === "text-only"
        ? this.thinkingDeltas.map((d) => ({
            type: "message_update",
            messageId,
            delta: { type: "thinking", text: d },
          }))
        : [];
    const textUpdates: Array<Record<string, unknown>> = this.textDeltas.map((d) => ({
      type: "message_update",
      messageId,
      delta: { type: "text", text: d },
    }));
    const tail: Array<Record<string, unknown>> = [
      { type: "message_end", messageId, role: "assistant" },
      { type: "turn_end" },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: this.textDeltas.join("") }],
            usage: this.usage,
          },
        ],
      },
      { type: "agent_settled" },
    ];

    let middle: Array<Record<string, unknown>> = [];
    switch (this.behavior) {
      case "text-only":
        middle = [];
        break;
      case "with-tool":
        middle = this.toolEvents();
        break;
      case "with-permission":
        middle = await this.permissionToolEvents();
        break;
      case "with-read":
        middle = await this.readToolEvents();
        break;
    }

    for (const ev of [...head, ...preText, ...textUpdates, ...middle, ...tail]) {
      this.emitLine(ev);
      // Let the adapter consume each event (keeps ordering observable).
      await new Promise((r) => setImmediate(r));
    }
    this.respond(
      id,
      "prompt",
      true,
      {
        sessionId: this.sessionId,
        text: this.textDeltas.join(""),
        promptText: text,
        usage: this.usage,
      },
    );
  }

  /** The simulated tool's spec with defaults. */
  private tool(): Required<FakeToolSpec> {
    const t = this.toolSpec;
    return {
      toolCallId: t.toolCallId ?? "tc-1",
      toolName: t.toolName ?? "bash",
      args: t.args ?? { command: "ls -la" },
      partialText: t.partialText ?? "total 1\n",
      resultText: t.resultText ?? "total 1\nfile1",
      isError: t.isError ?? false,
    };
  }

  /** "with-tool": plain tool execution events (no permission gate). */
  private toolEvents(): Array<Record<string, unknown>> {
    const t = this.tool();
    return [
      {
        type: "tool_execution_start",
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        args: t.args,
      },
      {
        type: "tool_execution_update",
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        partialResult: { content: [{ type: "text", text: t.partialText }] },
      },
      {
        type: "tool_execution_end",
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        result: { content: [{ type: "text", text: t.resultText }] },
        isError: t.isError,
      },
    ];
  }

  /**
   * "with-permission": gated tools ask the user via a simulated
   * extension_ui_request (select) BEFORE tool_execution_start and block
   * until the extension_ui_response arrives.
   */
  private async permissionToolEvents(): Promise<Array<Record<string, unknown>>> {
    const t = this.tool();
    if (!this.gatedTools.includes(t.toolName)) {
      return this.toolEvents();
    }
    const title = `[acp:perm] ${t.toolName} [id:${t.toolCallId}] ${JSON.stringify(t.args).slice(0, 80)}`;
    const resp = await this.extensionUiRequest({
      method: "select",
      title,
      options: ["allow_once", "reject_once"],
    });
    const denied =
      resp.cancelled === true || resp.value === undefined || resp.value === "reject_once";
    if (denied) {
      return [
        {
          type: "tool_execution_end",
          toolCallId: t.toolCallId,
          toolName: t.toolName,
          result: { content: [{ type: "text", text: "User denied" }] },
          isError: true,
        },
      ];
    }
    return this.toolEvents();
  }

  /**
   * "with-read": the simulated read-tool override requests the file from
   * the adapter via extension_ui_request (input, `[acp:read] <path>`).
   */
  private async readToolEvents(): Promise<Array<Record<string, unknown>>> {
    const toolCallId = this.toolSpec.toolCallId ?? "tc-read-1";
    const start: Record<string, unknown> = {
      type: "tool_execution_start",
      toolCallId,
      toolName: "read",
      args: { path: this.readPath },
    };
    if (!this.fsDelegation) {
      return [
        start,
        {
          type: "tool_execution_end",
          toolCallId,
          toolName: "read",
          result: { content: [{ type: "text", text: this.readFallbackText }] },
          isError: false,
        },
      ];
    }
    const resp = await this.extensionUiRequest({
      method: "input",
      title: `[acp:read] ${this.readPath}`,
      placeholder: "",
    });
    const content =
      typeof resp.value === "string"
        ? resp.value
        : this.readFallbackText; // cancelled -> simulated local fallback
    return [
      start,
      {
        type: "tool_execution_end",
        toolCallId,
        toolName: "read",
        result: { content: [{ type: "text", text: content }] },
        isError: false,
      },
    ];
  }

  /**
   * Emit an extension_ui_request on stdout and block (Promise) until the
   * matching extension_ui_response arrives on stdin — exactly what real pi
   * does in RPC mode for ctx.ui.select/confirm/input.
   */
  private extensionUiRequest(partial: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `extui-${++this.extUiSeq}`;
    this.emitLine({ ...partial, type: "extension_ui_request", id });
    return new Promise((res) => {
      this.extUiPending.set(id, res);
    });
  }

  private emitLine(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  private respond(
    id: string | number | undefined,
    command: string,
    success: boolean,
    data?: unknown,
    error?: string,
  ): void {
    this.emitLine({
      id,
      type: "response",
      command,
      success,
      ...(success ? { data: data ?? {} } : { error: error ?? "unknown error" }),
    });
  }

  // -- test helpers --------------------------------------------------------

  /** All commands of a given type, in order. */
  commandsOf(type: string): Array<Record<string, unknown>> {
    return this.commands.filter((c) => c.type === type);
  }
}

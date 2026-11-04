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
 * On `prompt` it emits the verified event order:
 *   session -> agent_start -> turn_start -> message_start ->
 *   message_update (xN) -> message_end -> turn_end -> agent_end -> agent_settled
 * and only then answers the correlated prompt command.
 */
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
}

export class FakePi implements PiProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = -1;

  /** Every command record received, in order (for test assertions). */
  readonly commands: Array<Record<string, unknown>> = [];

  private readonly emitter = new EventEmitter();
  private availableLevels: string[];
  private level: string;
  private readonly thinkingDeltas: string[];
  private readonly textDeltas: string[];
  private readonly usage: { input: number; output: number; thought?: number };
  private sessionId = "fake-pi-session-1";
  private lineBuffer = "";

  constructor(options: FakePiOptions = {}) {
    this.availableLevels = options.availableLevels ?? ["off", "low", "medium", "high"];
    this.level =
      options.initialLevel ?? (this.availableLevels.includes("medium") ? "medium" : this.availableLevels[0]);
    this.thinkingDeltas = options.thinkingDeltas ?? ["Let me think…", " …done thinking."];
    this.textDeltas = options.textDeltas ?? ["Hello", " world"];
    this.usage = options.usage ?? { input: 11, output: 22, thought: 3 };

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
    this.commands.push(cmd);
    const id = cmd.id as string | number | undefined;
    const type = String(cmd.type ?? "");

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
    const thinkingText = this.thinkingDeltas.join("");
    const textResult = this.textDeltas.join("");
    const events: Array<Record<string, unknown>> = [
      { type: "session", sessionId: this.sessionId },
      { type: "agent_start" },
      { type: "turn_start", turn: 0 },
      { type: "message_start", messageId, role: "assistant" },
      ...this.thinkingDeltas.map((d) => ({
        type: "message_update",
        messageId,
        delta: { type: "thinking", text: d },
      })),
      ...this.textDeltas.map((d) => ({
        type: "message_update",
        messageId,
        delta: { type: "text", text: d },
      })),
      { type: "message_end", messageId, role: "assistant" },
      { type: "turn_end" },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", text: thinkingText },
              { type: "text", text: textResult },
            ],
            usage: this.usage,
          },
        ],
      },
      { type: "agent_settled" },
    ];

    for (const ev of events) {
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
        text: textResult,
        promptText: text,
        usage: this.usage,
      },
    );
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

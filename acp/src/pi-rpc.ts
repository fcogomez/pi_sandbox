import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

/**
 * Minimal structural view of the child process the adapter needs.
 *
 * The real spawner returns a `ChildProcess`; unit tests inject an
 * in-process fake that satisfies this same shape (see test/fake-pi-rpc.ts).
 */
export interface PiProcessLike {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  readonly pid?: number;
}

/**
 * Injection seam for the pi spawner. Defaults to `pi --mode rpc`.
 */
export type PiSpawner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => PiProcessLike;

/**
 * A JSONL record emitted by pi on stdout.
 *
 * - Command responses: `{ id, type: "response", command, success, data | error }`
 * - Session events: `{ type: "<event>", ... }` (usually no `id`)
 */
export type PiRecord = {
  id?: string | number;
  type?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

export interface PiRpcOptions {
  /** Spawner; defaults to spawning the real `pi` binary in RPC mode. */
  spawner?: PiSpawner;
  /** Command to run (default: "pi"). */
  command?: string;
  /** Arguments (default: ["--mode", "rpc"]). */
  args?: string[];
  /**
   * Path of a pi extension to load via `-e` (appended after the base args
   * when set). A2 passes `acp/pi-extension.ts` (permission gate + read
   * override); pi loads it with its own tsx loader at runtime.
   */
  extensionPath?: string;
  /**
   * Extra env vars for the child (merged over the parent env): A2 sets
   * `ACP_FS_DELEGATION` ("1"/"0") and `ACP_GATED_TOOLS` (comma-joined).
   */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the pi process. */
  cwd?: string;
  /** Diagnostics sink; defaults to writing to process.stderr. */
  log?: (message: string) => void;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  command: string;
}

/**
 * Wrapper around a `pi --mode rpc` subprocess.
 *
 * Wire protocol: strict JSONL framing — ONE JSON object per line,
 * LF-terminated. We deliberately do NOT use a generic line reader (e.g.
 * node:readline) because it also splits on \r, U+2028 and U+2029; pi framing
 * splits on LF (0x0A) only.
 *
 * Command→response correlation is by a unique `id` and is fully async:
 * stdout is read continuously (in backpressure-aware `readable` mode) while
 * commands are written to stdin. Diagnostics go to the log sink (stderr),
 * never to stdout.
 */
export class PiRpc {
  private child: PiProcessLike | null = null;
  private readonly spawner: PiSpawner;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly extensionPath?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(record: PiRecord) => void>();
  private readonly extUiListeners = new Set<(record: PiRecord) => void>();
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 1;
  private closed = false;

  constructor(options: PiRpcOptions = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.command = options.command ?? "pi";
    this.args = options.args ?? ["--mode", "rpc"];
    this.cwd = options.cwd;
    this.extensionPath = options.extensionPath;
    this.env = options.env;
    this.log = options.log ?? ((m) => process.stderr.write(`[acp:pi] ${m}\n`));
  }

  /** Spawn the pi process and start pumping stdout. */
  start(): void {
    if (this.child) return;
    const args = this.extensionPath
      ? [...this.args, "-e", this.extensionPath]
      : this.args;
    const env = this.env ? { ...process.env, ...this.env } : undefined;
    const child = this.spawner(this.command, args, { cwd: this.cwd, env });
    this.child = child;

    child.stdout.on("readable", () => {
      // `readable` + `read()` keeps Node's internal backpressure intact:
      // we never let the socket buffer run ahead of us.
      let chunk: Buffer | string | null;
      while ((chunk = child.stdout.read()) !== null) {
        this.ingest(this.decoder.write(chunk as Buffer | string));
      }
    });
    child.stdout.on("end", () => {
      this.ingest(this.decoder.end());
      this.failAllPending("pi stdout closed (process exited)");
      this.closed = true;
    });
    child.stderr?.on("data", (d: Buffer) => {
      // Diagnostics go to stderr only, never onto the JSONL streams.
      this.log(String(d).trimEnd());
    });
    child.on("exit", (code) => {
      this.log(`pi exited (code=${code})`);
      this.failAllPending(`pi process exited (code=${code})`);
      this.closed = true;
    });
    child.on("error", (err) => {
      this.log(`pi process error: ${err.message}`);
      this.failAllPending(`pi process error: ${err.message}`);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send a command and await its correlated response.
   *
   * Command records are `{"id":"<id>","type":"<command>", ...args}`.
   * The response is `{"id":"<id>","type":"response","command","success", ...}`.
   * Rejects if `success` is falsy or the process dies first.
   */
  request(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.child) throw new Error("PiRpc not started; call start() first");
    if (this.closed) return Promise.reject(new Error("pi process is closed"));
    const id = `req-${this.nextId++}`;
    const record: PiRecord = { id, type: command, ...args };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, command });
      // Writes are LF-terminated JSONL. `write` is async and honors
      // backpressure; an error callback surfaces pipe failures (e.g. the
      // process died between the closed check and the write).
      this.child!.stdin.write(JSON.stringify(record) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
          this.log(`stdin write error: ${err.message}`);
        }
      });
    });
  }

  /**
   * Subscribe to the pi session event stream (records without a pending
   * command id). Returns an unsubscribe function.
   */
  onEvent(listener: (record: PiRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to extension UI requests (records with
   * `type: "extension_ui_request"`) emitted by pi extensions running inside
   * the RPC process — e.g. `ctx.ui.select(...)` (permission gate) or
   * `ctx.ui.input(...)` (read delegation) from the bundled pi-extension.ts.
   * These are routed here, NOT to the session event stream.
   * Returns an unsubscribe function.
   */
  onExtensionUiRequest(listener: (record: PiRecord) => void): () => void {
    this.extUiListeners.add(listener);
    return () => this.extUiListeners.delete(listener);
  }

  /**
   * Write an `extension_ui_response` back to pi's stdin, unblocking the
   * pending extension UI dialog:
   *   select  -> { id, value: "<selected option string>" }
   *   input   -> { id, value: "<text>" }
   *   confirm -> { id, confirmed: true|false }
   *   cancel  -> { id, cancelled: true }
   */
  writeExtensionUiResponse(
    id: string,
    value?: string,
    confirmed?: boolean,
    cancelled?: boolean,
  ): void {
    if (!this.child || this.closed) {
      this.log(`extension_ui_response dropped (pi closed): ${id}`);
      return;
    }
    const record: PiRecord = { type: "extension_ui_response", id };
    if (cancelled === true) record.cancelled = true;
    else if (value !== undefined) record.value = value;
    else if (confirmed !== undefined) record.confirmed = confirmed;
    this.child.stdin.write(JSON.stringify(record) + "\n", (err) => {
      if (err) this.log(`extension_ui_response write error: ${err.message}`);
    });
  }

  /** Terminate the pi process. */
  close(): void {
    if (!this.child) return;
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      // ignore
    }
    this.child = null;
    this.failAllPending("adapter closed pi process");
  }

  /**
   * Feed decoded stdout into the JSONL accumulator and dispatch complete
   * lines. Splits on LF (0x0A) ONLY — never on \r, U+2028 or U+2029.
   */
  private ingest(text: string): void {
    this.buffer += text;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === "") continue;
      let record: PiRecord;
      try {
        record = JSON.parse(line) as PiRecord;
      } catch (err) {
        this.log(`discarding malformed pi line: ${String(err)}`);
        continue;
      }
      this.dispatch(record);
    }
  }

  private dispatch(record: PiRecord): void {
    if (record.id !== undefined && this.pending.has(String(record.id))) {
      const pending = this.pending.get(String(record.id))!;
      this.pending.delete(String(record.id));
      if (record.success === false) {
        const msg =
          typeof record.error === "string"
            ? record.error
            : JSON.stringify(record.error ?? record.data ?? record.command ?? "unknown pi error");
        pending.reject(new Error(`pi command ${pending.command} failed: ${msg}`));
      } else {
        pending.resolve(record.data);
      }
      return;
    }
    // Extension UI requests are a request/response sub-protocol, not
    // session events: route them to their own subscribers and stop.
    if (record.type === "extension_ui_request") {
      for (const listener of [...this.extUiListeners]) {
        try {
          listener(record);
        } catch (err) {
          this.log(`extension_ui listener error: ${String(err)}`);
        }
      }
      return;
    }
    // Everything else is a session event (stream records usually carry no id).
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch (err) {
        this.log(`event listener error: ${String(err)}`);
      }
    }
  }

  private failAllPending(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }
}

function defaultSpawner(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): PiProcessLike {
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("failed to pipe stdio for pi RPC process");
  }
  return child as unknown as PiProcessLike;
}

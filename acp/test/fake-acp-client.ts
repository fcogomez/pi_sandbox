import {
  AgentSideConnection,
  ClientSideConnection,
  type AnyMessage,
  type Client,
  type InitializeRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "../src/acp-server.js";
import type { AcpConfig } from "../src/config.js";
import { FakePi } from "./fake-pi-rpc.js";

/**
 * Configurable FAKE ACP client for A2 unit tests (ticket ACP-A2).
 *
 * It records `sessionUpdate` notifications plus the ACP requests it is
 * asked to answer (`requestPermission`, `readTextFile`) and responds with
 * configurable values. The client is driven over an in-memory pair of
 * TransformStreams through the real SDK `ClientSideConnection`, so the
 * tests exercise the actual ACP wire framing. Fully offline.
 */

export interface FakeAcpClientOptions {
  /**
   * How the client answers `session/request_permission`.
   * Default: selects "allow_once".
   */
  respondPermission?: (
    params: RequestPermissionRequest,
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  /**
   * How the client answers `fs/read_text_file`.
   * Default: empty content.
   */
  respondReadTextFile?: (
    params: ReadTextFileRequest,
  ) => ReadTextFileResponse | Promise<ReadTextFileResponse>;
}

export class FakeAcpClient implements Client {
  /** Every session/update notification received, in order. */
  readonly updates: SessionNotification[] = [];
  /** Every requestPermission request received, in order. */
  readonly permissionRequests: RequestPermissionRequest[] = [];
  /** Every readTextFile request received, in order. */
  readonly readTextFileRequests: ReadTextFileRequest[] = [];

  private readonly respondPermission?: FakeAcpClientOptions["respondPermission"];
  private readonly respondReadTextFile?: FakeAcpClientOptions["respondReadTextFile"];

  constructor(options: FakeAcpClientOptions = {}) {
    this.respondPermission = options.respondPermission;
    this.respondReadTextFile = options.respondReadTextFile;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params);
    return (
      this.respondPermission?.(params) ?? {
        outcome: { outcome: "selected", optionId: "allow_once" },
      }
    );
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.readTextFileRequests.push(params);
    return this.respondReadTextFile?.(params) ?? { content: "" };
  }
}

/**
 * Default initialize params for A2 tests. Note: the SDK normalizes omitted
 * capability booleans to `false`, so `{ fs: { readTextFile: true } }` is
 * the way to advertise read support to the agent.
 */
export const DEFAULT_INIT_PARAMS: InitializeRequest = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true } },
  clientInfo: { name: "test-client", version: "0.1.0" },
};

export interface AcpHarnessOptions {
  client?: FakeAcpClient;
  config?: AcpConfig;
  fake?: FakePi;
  initParams?: InitializeRequest;
}

export interface AcpHarness {
  agent: PiAcpAgent;
  client: FakeAcpClient;
  conn: ClientSideConnection;
  fake: FakePi;
  close: () => Promise<void>;
}

/**
 * In-memory ACP harness: real SDK connections over TransformStreams on the
 * client side, in-process FakePi (spawner seam) on the pi side.
 */
export function makeAcpHarness(options: AcpHarnessOptions = {}): AcpHarness {
  const fake = options.fake ?? new FakePi();
  const client = options.client ?? new FakeAcpClient();
  const agent = new PiAcpAgent({
    config: options.config ?? { thinkingLevel: "medium" },
    spawner: () => fake, // seam: the adapter spawns the FAKE pi, never a real one
    log: () => {},
  });

  // agent writes -> client reads, client writes -> agent reads.
  const agentOut = new TransformStream<AnyMessage>();
  const clientOut = new TransformStream<AnyMessage>();

  const agentStream = {
    writable: agentOut.writable as WritableStream<AnyMessage>,
    readable: clientOut.readable as ReadableStream<AnyMessage>,
  };
  const clientStream = {
    writable: clientOut.writable as WritableStream<AnyMessage>,
    readable: agentOut.readable as ReadableStream<AnyMessage>,
  };

  const agentConn = new AgentSideConnection(
    (conn) => agent.attach(conn),
    agentStream,
  );
  const conn = new ClientSideConnection(() => client, clientStream);

  return {
    agent,
    client,
    conn,
    fake,
    close: async () => {
      agent.shutdown();
      void agentConn.closed;
      void conn.closed;
    },
  };
}

/** Convenience: run initialize with the given (or default) params. */
export async function initialize(h: AcpHarness, params?: InitializeRequest): Promise<void> {
  await h.conn.initialize(params ?? DEFAULT_INIT_PARAMS);
}

/**
 * Poll until `cond()` is true (or time out). Needed because the pi-RPC
 * pipeline (prompt response) and the ACP notification stream are separate
 * pipes: the last tool_call_update can still be in flight when `prompt`
 * resolves.
 */
export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
